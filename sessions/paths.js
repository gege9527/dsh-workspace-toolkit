/**
 * Filesystem facts the archived-session endpoints need.
 *
 * The session directory is never derived from the private projectKey /
 * encodeSegment algorithms: `sessionPersistence.stat().location` already
 * carries the backend-resolved artifact path, so this module only goes up one
 * level and proves the result stays inside the sessions root.
 */
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { httpError } from './http.js'

/** Directory holding every stored session for one workspace key. */
export function sessionsRoot(dshHome) {
  return join(dshHome, 'sessions')
}

function within(root, candidate) {
  const normalizedRoot = resolve(root) + sep
  return resolve(candidate).startsWith(normalizedRoot)
}

/**
 * Resolve one session's directory from persistence metadata.
 * @param services - host services (sessionPersistence is required).
 * @param dshHome - DSH config root.
 * @param sessionId - stored session id.
 * @returns the absolute session directory (all format generations live here).
 */
export async function resolveSessionDir(services, dshHome, sessionId) {
  let snapshot
  try {
    snapshot = await services.sessionPersistence.stat(sessionId)
  } catch (error) {
    const code = error && error.code ? String(error.code) : ''
    if (code === 'SESSION_FORMAT_UNSUPPORTED' || /format/i.test(String(error && error.message))) {
      throw httpError('sessions/migration-required', 'session format must be migrated before it can be read')
    }
    throw httpError('sessions/stat-failed', String(error && error.message ? error.message : error))
  }
  if (snapshot === undefined) throw httpError('sessions/not-found', 'session ' + sessionId + ' was not found')
  if (snapshot.formatStatus === 'migration-required') {
    throw httpError('sessions/migration-required', 'session format must be migrated before it can be read')
  }
  const location = snapshot.location
  if (location === undefined || typeof location.path !== 'string' || location.path === '') {
    throw httpError('sessions/no-artifact', 'session ' + sessionId + ' has no materialized artifact')
  }
  const dir = dirname(location.path)
  if (!within(sessionsRoot(dshHome), dir)) {
    throw httpError('sessions/outside-root', 'resolved session path escapes the sessions root')
  }
  return { dir, header: snapshot.header, snapshot }
}

/** Total bytes of every regular file below one directory, best effort. */
export async function directoryBytes(dir) {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await directoryBytes(path)
      continue
    }
    try {
      const info = await stat(path)
      total += info.size
    } catch {
      // A vanished entry contributes nothing.
    }
  }
  return total
}

/** Per-session projection cache in the directory layout. */
export function projectionCacheFile(dshHome, sessionId) {
  return join(dshHome, 'storages', 'session_projcache', 'sessions', sessionId + '.json')
}

/** Per-session projection cache in the single-file layout. */
export function projectionCacheUnitFile(dshHome) {
  return join(dshHome, 'storages', 'session_projcache.json')
}

/**
 * Remove this session's projection-cache record from both known layouts.
 * Cache loss is recoverable, so failures are reported as warnings rather than
 * failing the deletion.
 * @param dshHome - DSH config root.
 * @param sessionId - stored session id.
 * @returns warning strings (empty when both layouts were clean).
 */
export async function removeProjectionCache(dshHome, sessionId) {
  const warnings = []
  try {
    await rm(projectionCacheFile(dshHome, sessionId), { force: true })
  } catch (error) {
    warnings.push('projection cache file: ' + String(error && error.message ? error.message : error))
  }
  const unitFile = projectionCacheUnitFile(dshHome)
  try {
    const raw = await readFile(unitFile, 'utf8')
    const parsed = JSON.parse(raw)
    const sessions = parsed && parsed.tables && parsed.tables.sessions
    if (sessions !== null && typeof sessions === 'object' && Object.prototype.hasOwnProperty.call(sessions, sessionId)) {
      delete sessions[sessionId]
      const temporary = unitFile + '.' + String(process.pid) + '.tmp'
      await writeFile(temporary, JSON.stringify(parsed) + '\n', 'utf8')
      await rename(temporary, unitFile)
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      warnings.push('projection cache unit: ' + String(error && error.message ? error.message : error))
    }
  }
  return warnings
}

/**
 * Remove a session's whole directory, then drop the parent workspace key
 * directory when nothing else lives there.
 * @param dir - absolute session directory.
 * @returns the released byte count.
 */
export async function removeSessionDirectory(dir) {
  const bytes = await directoryBytes(dir)
  await rm(dir, { recursive: true, force: true })
  const parent = dirname(dir)
  try {
    const left = await readdir(parent)
    if (left.length === 0) await rm(parent, { recursive: true, force: true })
  } catch {
    // A missing or unreadable parent means there is nothing left to tidy.
  }
  return bytes
}
