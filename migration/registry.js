/**
 * Workspace-registry completion for migration.
 *
 * The registry's session-path index is populated at startup and has no public
 * refresh entry point. Inline completion therefore uses a feature-detected
 * private refresh (indexHeader or the index collections) and falls back to the
 * next Host start (boot mode) when that surface is absent or incompatible.
 */
import { realpath } from 'node:fs/promises'
import { writeJournal } from './journal.js'

/** Describe which inline refresh surface this running registry exposes. */
export function detectRegistryCompat(registry) {
  if (!registry || typeof registry.list !== 'function') {
    return { inline: false, via: 'none', reason: 'workspace registry is unavailable' }
  }
  if (typeof registry.indexHeader === 'function') {
    return { inline: true, via: 'indexHeader', reason: 'registry.indexHeader is available' }
  }
  if (registry.headers instanceof Map
    && registry.sessionPaths instanceof Map
    && registry.missingSessionPaths instanceof Set
    && registry.invalidSessionPaths instanceof Map) {
    return { inline: true, via: 'maps', reason: 'registry index collections are writable' }
  }
  return { inline: false, via: 'none', reason: 'registry session-path index cannot be refreshed in-process' }
}

async function canonicalCwd(header) {
  return await realpath(header.cwd)
}

/** Refresh one session's header/path index entry. */
export async function refreshRegistryHeader(registry, header) {
  const compat = detectRegistryCompat(registry)
  if (!compat.inline) {
    const error = new Error(compat.reason)
    error.code = 'migration/inline-unavailable'
    throw error
  }
  if (compat.via === 'indexHeader') {
    await registry.indexHeader(header)
    return
  }
  const path = await canonicalCwd(header)
  registry.headers.set(header.id, header)
  registry.sessionPaths.set(header.id, path)
  registry.missingSessionPaths.delete(header.id)
  registry.invalidSessionPaths.delete(header.id)
}

function workspaceAt(registry, path) {
  for (const workspace of registry.list()) {
    if (workspace.path === path) return workspace
  }
  return undefined
}

function assertJournalSessions(journal, entity) {
  const accounted = new Set(entity.sessionIds)
  for (const id of journal.orderedSessionIds) {
    if (!accounted.has(id)) throw new Error('workspace completion lost session ' + id)
  }
}

function isMarkerMatch(existing, journal) {
  return Boolean(existing && journal.markerTitle && existing.title === journal.markerTitle)
}

/**
 * Rebuild the target workspace and attach every migrated session.
 * Safe to call repeatedly: adoption by markerTitle/newWorkspaceId makes a
 * crash between create and journal write recoverable.
 */
export async function completeRegistry(dshHome, registry, journal, options) {
  const inline = options && options.inline === true
  if (inline) {
    for (const session of journal.sessions) {
      const snapshot = await options.sessionPersistence.stat(session.id)
      if (snapshot === undefined || snapshot.header === undefined) {
        throw new Error('session persistence no longer lists ' + session.id)
      }
      if (snapshot.header.cwd !== journal.newPath) {
        throw new Error('session ' + session.id + ' header cwd is ' + JSON.stringify(snapshot.header.cwd))
      }
      await refreshRegistryHeader(registry, snapshot.header)
    }
  }

  let entity = workspaceAt(registry, journal.newPath)
  if (entity !== undefined) {
    const known = journal.newWorkspaceId !== null && journal.newWorkspaceId !== undefined
      && entity.id === journal.newWorkspaceId
    if (!known && !isMarkerMatch(entity, journal)) {
      const error = new Error('target path is already registered as another workspace')
      error.code = 'migration/target-owned'
      throw error
    }
  } else {
    entity = await registry.create(journal.newPath, journal.markerTitle)
    journal.newWorkspaceId = entity.id
    journal.state = 'completing'
    journal.completionMode = inline ? 'inline' : 'boot'
    await writeJournal(dshHome, journal)
    if (options && typeof options.crash === 'function') options.crash('after-create-workspace')
  }
  if (journal.newWorkspaceId === null || journal.newWorkspaceId === undefined) {
    journal.newWorkspaceId = entity.id
    await writeJournal(dshHome, journal)
  }

  if (entity.title !== journal.workspaceTitle) {
    await entity.setTitle(journal.workspaceTitle)
  }

  for (const id of journal.orderedSessionIds) {
    await entity.detachSession(id)
  }
  for (let index = journal.orderedSessionIds.length - 1; index >= 0; index -= 1) {
    await entity.attachSession(journal.orderedSessionIds[index])
    if (options && typeof options.crash === 'function') options.crash('after-attach-session')
  }

  if (journal.workspaceId && journal.workspaceId !== entity.id) {
    const previous = registry.get(journal.workspaceId)
    if (previous !== undefined) {
      await registry.insertBefore(entity.id, journal.workspaceId)
      await registry.delete(journal.workspaceId)
      if (options && typeof options.crash === 'function') options.crash('after-delete-old-workspace')
    }
  }

  if (journal.options && journal.options.unarchive === true) {
    for (const id of journal.orderedSessionIds) {
      await registry.unarchiveSession(id)
    }
  }

  const verified = registry.list().filter(workspace => workspace.path === journal.newPath)
  if (verified.length !== 1 || verified[0].id !== entity.id) {
    throw new Error('workspace completion verification failed: target path is not unique')
  }
  assertJournalSessions(journal, entity)
  if (journal.workspaceId && journal.workspaceId !== entity.id && registry.get(journal.workspaceId) !== undefined) {
    throw new Error('workspace completion verification failed: previous workspace still exists')
  }
  return entity
}
