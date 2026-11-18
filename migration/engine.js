/**
 * Workspace migration engine: preflight, file preparation, completion,
 * rollback, and boot recovery.
 */
import { randomBytes } from 'node:crypto'
import {
  mkdir, readdir, realpath, rename, stat, statfs,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  canonicalExistingDirectory, encodeSegment, isInside, projectKey, sessionsRoot,
} from './paths.js'
import { readLogHeader, rewriteLogHeader } from './log.js'
import {
  JOURNAL_SCHEMA_VERSION, acquireLock, archiveJournal, crashPoint,
  listJournals, removeJournal, sha256, snapshotRegistry, writeJournal,
} from './journal.js'
import { completeRegistry, detectRegistryCompat } from './registry.js'
import { SESSION_FORMAT_VERSION } from './compat.js'

const GENERATION_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/

function migrationError(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function nowIso() {
  return new Date().toISOString()
}

function newJournalId() {
  return 'mig-' + Date.now().toString(36) + '-' + randomBytes(4).toString('hex')
}

function b64(buffer) {
  return Buffer.from(buffer).toString('base64')
}

function unb64(text) {
  return Buffer.from(text, 'base64')
}

/** List canonical session generation files in one session directory. */
async function generationFiles(directory) {
  const names = await readdir(directory)
  const found = []
  for (const name of names) {
    const match = GENERATION_RE.exec(name)
    if (!match) continue
    const version = match[1] === undefined ? 0 : Number(match[1])
    found.push({
      name,
      version,
      compression: match[2] === '.zstd' ? 'zstd' : 'none',
      path: join(directory, name),
    })
  }
  return found
}

async function locateGeneration(snapshot, root) {
  const location = snapshot.location && snapshot.location.path
  if (typeof location === 'string' && location !== '') {
    if (!isInside(root, location)) throw migrationError('migration/unsupported-format', 'session artifact is outside the session root: ' + location)
    const match = GENERATION_RE.exec(basename(location))
    if (match === null) throw migrationError('migration/unsupported-format', 'session artifact is not a canonical generation file: ' + location)
    const version = match[1] === undefined ? 0 : Number(match[1])
    return { path: location, version, compression: match[2] === '.zstd' ? 'zstd' : 'none', dir: dirname(location) }
  }
  const directory = join(root, projectKey(snapshot.header.cwd), encodeSegment(snapshot.header.id))
  const files = await generationFiles(directory)
  if (files.length === 0) throw migrationError('migration/unsupported-format', 'no canonical session log for ' + snapshot.header.id)
  files.sort((left, right) => right.version - left.version)
  const highest = files[0]
  if (files.some(file => file.version === highest.version && file !== highest)) {
    throw migrationError('migration/unsupported-format', 'ambiguous session generation for ' + snapshot.header.id)
  }
  return { path: highest.path, version: highest.version, compression: highest.compression, dir: directory }
}

async function resolvesTo(path, expected) {
  if (path === expected) return true
  if (typeof path !== 'string' || path === '') return false
  try {
    return (await realpath(path)) === expected
  } catch {
    return false
  }
}

function assertSupportedGeneration(session) {
  if (session.version !== SESSION_FORMAT_VERSION) {
    throw migrationError(
      'migration/unsupported-format',
      'session ' + session.id + ' uses format v' + session.version + '; only v' + SESSION_FORMAT_VERSION + ' is supported',
      { sessionId: session.id, version: session.version },
    )
  }
}

function sessionSummary(session, archived) {
  return {
    id: session.id,
    accounted: session.accounted,
    archived,
    sizeBytes: session.sizeBytes,
    compression: session.compression,
  }
}

async function enumerateSessions(ctx, workspace, oldPath, root) {
  const persistence = ctx.sessionPersistence
  if (!persistence || typeof persistence.list !== 'function') {
    throw migrationError('migration/unsupported-format', 'session persistence is unavailable')
  }
  const snapshots = await persistence.list()
  const byId = new Map()
  for (const snapshot of snapshots) {
    if (snapshot && snapshot.header && typeof snapshot.header.id === 'string') byId.set(snapshot.header.id, snapshot)
  }
  const accounted = Array.isArray(workspace.sessionIds) ? [...workspace.sessionIds] : []
  const accountedSet = new Set(accounted)
  const orderedIds = []
  for (const id of accounted) {
    if (!byId.has(id)) {
      throw migrationError('migration/unsupported-session', 'accounted session is missing from persistence: ' + id, { sessionId: id })
    }
    orderedIds.push(id)
  }
  const matchesOld = new Map()
  for (const snapshot of snapshots) {
    matchesOld.set(snapshot.header.id, await resolvesTo(snapshot.header.cwd, oldPath))
  }
  for (const snapshot of snapshots) {
    const id = snapshot.header.id
    if (accountedSet.has(id)) continue
    if (matchesOld.get(id) === true) orderedIds.push(id)
  }

  const archived = new Set((ctx.workspaceRegistry.archivedSessionIds || []).map(String))
  const sessions = []
  for (const id of orderedIds) {
    const snapshot = byId.get(id)
    if (matchesOld.get(id) !== true) {
      throw migrationError(
        'migration/unsupported-session',
        'session ' + id + ' belongs to ' + JSON.stringify(snapshot.header.cwd) + ' instead of the workspace path',
        { sessionId: id, cwd: snapshot.header.cwd },
      )
    }
    const generation = await locateGeneration(snapshot, root)
    assertSupportedGeneration({ id, version: generation.version })
    const info = await stat(generation.path)
    const session = {
      id,
      accounted: accountedSet.has(id),
      archived: archived.has(id),
      cwd: snapshot.header.cwd,
      headerCreatedAt: snapshot.header.createdAt,
      oldDir: generation.dir,
      newDir: null,
      generationName: basename(generation.path),
      compression: generation.compression,
      version: generation.version,
      sizeBytes: info.size,
      allocatedBytes: 0,
    }
    sessions.push(session)
  }
  return sessions
}

async function assertInactive(ctx, sessions) {
  const active = []
  for (const session of sessions) {
    if (ctx.sessions && typeof ctx.sessions.get === 'function' && ctx.sessions.get(session.id) !== undefined) {
      active.push({ sessionId: session.id, kind: 'live' })
    }
  }
  if (active.length > 0) {
    throw migrationError('migration/sessions-active', 'some sessions are still active', { activity: active })
  }
  if (typeof ctx.waterfall === 'function') {
    for (const session of sessions) {
      const activity = await ctx.waterfall(
        'workspace/session-activity',
        { sessionId: session.id },
        () => Promise.resolve([]),
      )
      if (Array.isArray(activity) && activity.length > 0) {
        active.push({ sessionId: session.id, activity })
      }
    }
  }
  if (active.length > 0) {
    throw migrationError('migration/sessions-active', 'some sessions are still active', { activity: active })
  }
}

async function assertFreeSpace(sessions, root) {
  let total = 0
  for (const session of sessions) total += session.sizeBytes
  let info
  try {
    info = await statfs(root)
  } catch {
    return
  }
  const free = Number(info.bavail) * Number(info.bsize)
  const reserve = 16 * 1024 * 1024
  if (Number.isFinite(free) && free < total + reserve) {
    throw migrationError('migration/io', 'not enough free space for migration', { requiredBytes: total + reserve, freeBytes: free })
  }
}

async function assertNoPendingJournal(dshHome) {
  const entries = await listJournals(dshHome)
  const corrupt = entries.filter(entry => entry.journal === undefined)
  if (corrupt.length > 0) {
    throw migrationError('migration/journal-corrupt', 'a migration journal cannot be read; manual recovery is required', {
      journals: corrupt.map(entry => ({ path: entry.path, error: entry.error })),
    })
  }
  const pending = entries.filter(entry => entry.journal && entry.journal.state !== 'complete' && entry.journal.state !== 'rolled-back')
  if (pending.length > 0) {
    throw migrationError('migration/pending', 'another migration is pending', {
      journals: pending.map(entry => ({ id: entry.journal.id, state: entry.journal.state })),
    })
  }
}

/** Report whether exactly one workspace directory exists (O(1); never scans all). */
export async function workspaceStatus(registry, workspaceId) {
  const rows = []
  if (typeof workspaceId !== 'string' || workspaceId === '') return rows
  const workspace = registry.get(workspaceId)
  if (workspace === undefined) return rows
  let exists = false
  try {
    exists = (await stat(workspace.path)).isDirectory()
  } catch {
    exists = false
  }
  rows.push({ workspaceId: workspace.id, path: workspace.path, exists })
  return rows
}

/**
 * Build a complete preflight plan. Throws a coded error for every refusal.
 */
export async function preflight(ctx, dshHome, workspaceId, targetPath) {
  const registry = ctx.workspaceRegistry
  const workspace = registry && typeof registry.get === 'function' ? registry.get(workspaceId) : undefined
  if (workspace === undefined) throw migrationError('migration/workspace-not-found', 'workspace not found')
  const root = sessionsRoot(dshHome)
  const oldPath = workspace.path
  const sourceExists = await stat(oldPath).then(info => info.isDirectory(), () => false)
  if (sourceExists) {
    throw migrationError(
      'migration/source-present',
      'the workspace directory still exists; migration is only for a workspace whose directory is missing',
      { path: oldPath },
    )
  }
  const newPath = await canonicalExistingDirectory(targetPath)
  if (newPath === oldPath) throw migrationError('migration/same-path', 'source and target are the same directory')
  for (const candidate of registry.list()) {
    if (candidate.path === newPath && candidate.id !== workspace.id) {
      throw migrationError('migration/target-owned', 'target path already belongs to another workspace', { workspaceId: candidate.id })
    }
  }
  await assertNoPendingJournal(dshHome)
  const sessions = await enumerateSessions(ctx, workspace, oldPath, root)
  for (const session of sessions) {
    session.newDir = join(root, projectKey(newPath), encodeSegment(session.id))
  }
  await assertInactive(ctx, sessions)
  await assertFreeSpace(sessions, root)
  const compat = detectRegistryCompat(registry)
  const archivedCount = sessions.filter(session => session.archived).length
  return {
    workspaceId: workspace.id,
    workspaceTitle: workspace.title,
    oldPath,
    newPath,
    sessionCount: sessions.length,
    accountedCount: sessions.filter(session => session.accounted).length,
    subagentCount: sessions.filter(session => !session.accounted).length,
    archivedCount,
    totalBytes: sessions.reduce((sum, session) => sum + session.sizeBytes, 0),
    completionMode: compat.inline ? 'inline' : 'boot',
    compat,
    sessions,
  }
}

function createJournal(plan) {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    id: newJournalId(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    state: 'prepared',
    completionMode: plan.completionMode,
    workspaceId: plan.workspaceId,
    workspaceTitle: plan.workspaceTitle,
    oldPath: plan.oldPath,
    newPath: plan.newPath,
    markerTitle: '__wstk_migrate_' + randomBytes(6).toString('hex') + '__',
    newWorkspaceId: null,
    registryStarted: false,
    orderedSessionIds: plan.sessions.filter(session => session.accounted).map(session => session.id),
    options: { unarchive: false },
    sessions: plan.sessions.map(session => ({
      id: session.id,
      accounted: session.accounted,
      archived: session.archived,
      oldDir: session.oldDir,
      newDir: session.newDir,
      generationName: session.generationName,
      compression: session.compression,
      oldSize: session.sizeBytes,
      oldHeaderBase64: null,
      moved: false,
      rewritten: false,
      verified: false,
    })),
    error: null,
    steps: [],
  }
}

function markStep(journal, step, detail) {
  journal.steps.push({ at: nowIso(), step, detail: detail === undefined ? null : detail })
  if (journal.steps.length > 200) journal.steps.splice(0, journal.steps.length - 200)
}

async function prepareOneSession(ctx, dshHome, journal, session) {
  const persistence = ctx.sessionPersistence
  let handle
  try {
    handle = await persistence.open(session.id, 'write')
  } catch (error) {
    throw migrationError('migration/busy', 'cannot acquire the session write lease for ' + session.id + ': ' + String(error && error.message ? error.message : error), { sessionId: session.id })
  }
  try {
    if (ctx.sessions && typeof ctx.sessions.get === 'function' && ctx.sessions.get(session.id) !== undefined) {
      throw migrationError('migration/sessions-active', 'session became live during migration', { sessionId: session.id })
    }
    const oldExists = await stat(session.oldDir).then(() => true, () => false)
    const newExists = await stat(session.newDir).then(() => true, () => false)
    if (!oldExists && !newExists) {
      throw migrationError('migration/io', 'session directory disappeared: ' + session.oldDir, { sessionId: session.id })
    }
    if (oldExists && newExists) {
      throw migrationError('migration/target-exists', 'target session directory already exists: ' + session.newDir, { sessionId: session.id })
    }
    if (oldExists) {
      await mkdir(dirname(session.newDir), { recursive: true, mode: 0o700 })
      crashPoint('before-rename')
      await rename(session.oldDir, session.newDir)
      session.moved = true
      markStep(journal, 'session-moved', session.id)
      await writeJournal(dshHome, journal)
      crashPoint('after-rename')
    } else {
      session.moved = true
    }

    const currentFile = join(session.newDir, session.generationName)
    const current = await readLogHeader(currentFile, session.id)
    if (current.header.cwd === journal.newPath) {
      session.rewritten = true
      session.verified = true
      await writeJournal(dshHome, journal)
    } else {
      if (!(await resolvesTo(current.header.cwd, journal.oldPath))) {
        throw migrationError('migration/unsupported-session', 'session cwd changed unexpectedly: ' + current.header.cwd, { sessionId: session.id })
      }
      const result = await rewriteLogHeader(currentFile, {
        expectedId: session.id,
        cwd: journal.newPath,
        expectedCwd: journal.newPath,
      })
      session.oldHeaderBase64 = b64(result.oldHeaderBytes)
      session.oldSize = result.oldSize
      session.rewritten = true
      session.verified = true
      markStep(journal, 'session-header-rewritten', session.id)
      await writeJournal(dshHome, journal)
      crashPoint('after-rewrite')
    }
    const finalInfo = await readLogHeader(join(session.newDir, session.generationName), session.id)
    if (finalInfo.header.cwd !== journal.newPath) {
      throw migrationError('migration/io', 'session header verification failed: ' + session.id, { sessionId: session.id })
    }
    crashPoint('after-verify')
  } finally {
    await handle.close().catch(() => {})
  }
}

async function runFilePreparation(ctx, dshHome, journal) {
  for (const session of journal.sessions) {
    crashPoint('before-session')
    if (!session.moved || !session.rewritten || !session.verified) {
      await prepareOneSession(ctx, dshHome, journal, session)
    }
  }
  journal.state = 'files-moved'
  markStep(journal, 'files-moved')
  await writeJournal(dshHome, journal)
  crashPoint('files-moved')
}

function bestEffortLedger(dshHome, journal) {
  const oldDir = join(dshHome, 'change-ledger', 'v1', 'workspaces', sha256(journal.oldPath))
  const newDir = join(dshHome, 'change-ledger', 'v1', 'workspaces', sha256(journal.newPath))
  rename(oldDir, newDir).catch(() => {})
}

async function finishInline(ctx, dshHome, journal) {
  journal.state = 'completing'
  journal.completionMode = 'inline'
  journal.registryStarted = true
  markStep(journal, 'inline-completion-start')
  await writeJournal(dshHome, journal)
  await completeRegistry(dshHome, ctx.workspaceRegistry, journal, {
    inline: true,
    sessionPersistence: ctx.sessionPersistence,
    crash: crashPoint,
  })
  journal.state = 'complete'
  journal.finishedAt = nowIso()
  markStep(journal, 'complete-inline')
  await writeJournal(dshHome, journal)
  bestEffortLedger(dshHome, journal)
  await archiveJournal(dshHome, journal)
  return journal
}

async function deferToRestart(dshHome, journal, error) {
  journal.state = 'awaiting-restart'
  journal.completionMode = 'boot'
  journal.error = error ? String(error.message ? error.message : error) : null
  markStep(journal, 'deferred-to-restart', journal.error)
  await writeJournal(dshHome, journal)
  return journal
}

/** Prepare files and try inline completion; returns the journal. */
export async function prepare(ctx, dshHome, workspaceId, targetPath, options) {
  const plan = await preflight(ctx, dshHome, workspaceId, targetPath)
  const release = await acquireLock(dshHome, 'pending')
  let journal = null
  try {
    journal = createJournal(plan)
    if (options && options.unarchive === true) journal.options.unarchive = true
    await writeJournal(dshHome, journal)
    try {
      const snapshot = await snapshotRegistry(dshHome, journal, {
        workspace: { id: plan.workspaceId, title: plan.workspaceTitle, path: plan.oldPath },
        sessions: plan.sessions.map(session => ({ id: session.id, accounted: session.accounted, size: session.sizeBytes })),
      })
      journal.snapshotDir = snapshot.dir
    } catch (error) {
      markStep(journal, 'snapshot-failed', String(error && error.message ? error.message : error))
      await writeJournal(dshHome, journal)
    }
    try {
      await runFilePreparation(ctx, dshHome, journal)
    } catch (error) {
      journal.state = 'failed'
      journal.error = String(error && error.message ? error.message : error)
      markStep(journal, 'prepare-failed', journal.error)
      await writeJournal(dshHome, journal)
      if (error && typeof error === 'object' && journal) error.migrationId = journal.id
      throw error
    }

    const compat = detectRegistryCompat(ctx.workspaceRegistry)
    if (!compat.inline) {
      await deferToRestart(dshHome, journal, new Error(compat.reason))
      return { journal, completionMode: 'boot' }
    }
    try {
      await finishInline(ctx, dshHome, journal)
      return { journal, completionMode: 'inline' }
    } catch (error) {
      await deferToRestart(dshHome, journal, error)
      return { journal, completionMode: 'boot', warning: String(error && error.message ? error.message : error) }
    }
  } finally {
    await release()
  }
}

async function restoreSessionCwd(dshHome, journal, session) {
  const currentFile = join(session.newDir, session.generationName)
  const current = await readLogHeader(currentFile, session.id)
  const headerBytes = session.oldHeaderBase64
    ? unb64(session.oldHeaderBase64)
    : Buffer.from(JSON.stringify({ ...current.header, cwd: journal.oldPath }) + '\n', 'utf8')
  await rewriteLogHeader(currentFile, {
    expectedId: session.id,
    headerBytes,
    expectedCwd: journal.oldPath,
  })
}

/** Roll files back; only valid before registry completion starts. */
export async function rollback(ctx, dshHome, migrationId) {
  const entries = await listJournals(dshHome)
  const found = entries.find(entry => entry.journal && (migrationId === undefined || entry.journal.id === migrationId))
  if (!found || !found.journal) throw migrationError('migration/not-found', 'migration journal not found')
  const journal = found.journal
  if (journal.registryStarted === true || journal.state === 'completing' || journal.state === 'complete') {
    throw migrationError('migration/completion-started', 'workspace completion already started; retry completion or migrate back instead')
  }
  const release = await acquireLock(dshHome, journal.id)
  try {
    for (let index = journal.sessions.length - 1; index >= 0; index -= 1) {
      const session = journal.sessions[index]
      const oldExists = await stat(session.oldDir).then(() => true, () => false)
      const newExists = await stat(session.newDir).then(() => true, () => false)
      if (oldExists && newExists) {
        throw migrationError('migration/io', 'both old and new session directories exist: ' + session.id, { sessionId: session.id })
      }
      if (newExists) {
        await restoreSessionCwd(dshHome, journal, session)
        await mkdir(dirname(session.oldDir), { recursive: true, mode: 0o700 })
        await rename(session.newDir, session.oldDir)
      }
    }
    journal.state = 'rolled-back'
    journal.finishedAt = nowIso()
    markStep(journal, 'rolled-back')
    await writeJournal(dshHome, journal)
    await removeJournal(dshHome, journal)
    return { journal, state: 'rolled-back' }
  } finally {
    await release()
  }
}

/** Attempt completion again; used by the client after an inline failure. */
export async function retryComplete(ctx, dshHome, migrationId) {
  const entries = await listJournals(dshHome)
  const found = entries.find(entry => entry.journal && (migrationId === undefined || entry.journal.id === migrationId))
  if (!found || !found.journal) throw migrationError('migration/not-found', 'migration journal not found')
  const journal = found.journal
  const release = await acquireLock(dshHome, journal.id)
  try {
    if (journal.state === 'prepared' || journal.state === 'failed') {
      await assertInactive(ctx, journal.sessions)
      await runFilePreparation(ctx, dshHome, journal)
    }
    const compat = detectRegistryCompat(ctx.workspaceRegistry)
    if (!compat.inline) {
      await deferToRestart(dshHome, journal, new Error(compat.reason))
      return { journal, completionMode: 'boot' }
    }
    try {
      await finishInline(ctx, dshHome, journal)
      return { journal, completionMode: 'inline' }
    } catch (error) {
      await deferToRestart(dshHome, journal, error)
      throw error
    }
  } finally {
    await release()
  }
}

/** Complete journals whose files are already prepared (Host startup path). */
export async function completePendingOnBoot(ctx, dshHome, logger) {
  const entries = await listJournals(dshHome)
  for (const entry of entries) {
    if (!entry.journal) {
      if (logger && logger.warn) logger.warn('[workspace-toolkit] unreadable migration journal: ' + entry.path)
      continue
    }
    const journal = entry.journal
    if (journal.state === 'prepared' || journal.state === 'failed') {
      const ready = Array.isArray(journal.sessions)
        && journal.sessions.length > 0
        && journal.sessions.every(session => session.verified === true)
      if (!ready) continue
      journal.state = 'files-moved'
      markStep(journal, 'boot-recovered-files')
      await writeJournal(dshHome, journal)
    }
    if (journal.state !== 'files-moved' && journal.state !== 'awaiting-restart' && journal.state !== 'completing') continue
    let release
    try {
      release = await acquireLock(dshHome, journal.id)
    } catch (error) {
      if (logger && logger.warn) logger.warn('[workspace-toolkit] migration lock is busy: ' + String(error))
      continue
    }
    try {
      journal.state = 'completing'
      journal.completionMode = 'boot'
      journal.registryStarted = true
      markStep(journal, 'boot-completion-start')
      await writeJournal(dshHome, journal)
      await completeRegistry(dshHome, ctx.workspaceRegistry, journal, {
        inline: false,
        sessionPersistence: ctx.sessionPersistence,
        crash: crashPoint,
      })
      journal.state = 'complete'
      journal.finishedAt = nowIso()
      markStep(journal, 'complete-boot')
      await writeJournal(dshHome, journal)
      bestEffortLedger(dshHome, journal)
      await archiveJournal(dshHome, journal)
      if (logger && logger.info) logger.info('[workspace-toolkit] completed workspace migration ' + journal.id)
    } catch (error) {
      journal.state = 'awaiting-restart'
      journal.error = String(error && error.message ? error.message : error)
      markStep(journal, 'boot-completion-failed', journal.error)
      await writeJournal(dshHome, journal)
      if (logger && logger.warn) logger.warn('[workspace-toolkit] migration ' + journal.id + ' completion failed: ' + journal.error)
    } finally {
      await release()
    }
  }
}

/** Pending journal summaries for the client banner and status API. */
export async function status(dshHome) {
  const entries = await listJournals(dshHome)
  const journals = []
  for (const entry of entries) {
    if (!entry.journal) {
      journals.push({ path: entry.path, corrupt: true, error: entry.error })
      continue
    }
    const journal = entry.journal
    journals.push({
      id: journal.id,
      state: journal.state,
      completionMode: journal.completionMode,
      registryStarted: journal.registryStarted === true,
      workspaceTitle: journal.workspaceTitle,
      oldPath: journal.oldPath,
      newPath: journal.newPath,
      sessionCount: journal.sessions.length,
      error: journal.error,
      createdAt: journal.createdAt,
    })
  }
  return { journals }
}