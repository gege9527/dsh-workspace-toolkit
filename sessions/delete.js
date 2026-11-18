/**
 * Delete archived sessions: unarchive through the public registry API, then
 * remove the log directory and the derived projection-cache record.
 *
 * Order is fixed (design D2): validate archived -> reject active -> unarchive ->
 * resolve path -> delete files -> clear cache. A failure after unarchive leaves
 * the session "unarchived but still on disk", which the error text spells out.
 */
import { httpError } from './http.js'
import {
  removeProjectionCache, removeSessionDirectory, resolveSessionDir,
} from './paths.js'

/** Upper bound for one request; the UI deletes a handful at a time. */
export const MAX_DELETE_IDS = 200

function codeOf(error) {
  return error && typeof error.code === 'string' && error.code !== '' ? error.code : 'sessions/internal'
}

function messageOf(error) {
  return String(error && error.message ? error.message : error)
}

/** Archived ids as a Set of strings, tolerant of array or iterable snapshots. */
export function archivedIdSet(workspaceRegistry) {
  const raw = workspaceRegistry && workspaceRegistry.archivedSessionIds
  const ids = []
  if (raw && typeof raw[Symbol.iterator] === 'function') {
    for (const value of raw) ids.push(String(value))
  }
  return new Set(ids)
}

/**
 * Delete one archived session.
 * @param services - host services.
 * @param dshHome - DSH config root.
 * @param sessionId - candidate id.
 * @param archived - archived id set captured once per request.
 * @returns one result plus the released bytes.
 */
async function deleteOne(services, dshHome, sessionId, archived) {
  let stage = 'validate'
  try {
    if (!archived.has(sessionId)) {
      throw httpError('sessions/not-archived', 'session ' + sessionId + ' is not archived')
    }
    stage = 'activity'
    const live = services.sessions && typeof services.sessions.get === 'function'
      ? services.sessions.get(sessionId)
      : undefined
    if (live !== undefined && live !== null) {
      throw httpError('sessions/active', 'session ' + sessionId + ' still has active work')
    }
    stage = 'unarchive'
    await services.workspaceRegistry.unarchiveSession(sessionId)
    stage = 'resolve-path'
    const resolved = await resolveSessionDir(services, dshHome, sessionId)
    stage = 'remove-files'
    const bytes = await removeSessionDirectory(resolved.dir)
    stage = 'projection-cache'
    const warnings = await removeProjectionCache(dshHome, sessionId)
    return {
      result: { id: sessionId, ok: true, stage: 'done', bytes, ...(warnings.length > 0 ? { warnings } : {}) },
      bytes,
    }
  } catch (error) {
    const unarchived = stage !== 'validate' && stage !== 'activity'
    const note = unarchived
      ? ' (the session is now unarchived but its logs are still on disk; retry the deletion or keep using it)'
      : ''
    return {
      result: {
        id: sessionId,
        ok: false,
        stage,
        error: { code: codeOf(error), message: messageOf(error) + note },
        unarchived,
      },
      bytes: 0,
    }
  }
}

/**
 * Delete every requested archived session, independently per id.
 * @param services - host services (workspaceRegistry, sessionPersistence, sessions).
 * @param dshHome - DSH config root.
 * @param ids - candidate session ids.
 * @returns ordered per-id results and the total released bytes.
 */
export async function deleteArchivedSessions(services, dshHome, ids) {
  const archived = archivedIdSet(services.workspaceRegistry)
  const results = []
  let freedBytes = 0
  for (const id of ids) {
    const outcome = await deleteOne(services, dshHome, id, archived)
    results.push(outcome.result)
    freedBytes += outcome.bytes
    if (outcome.result.ok) archived.delete(id)
  }
  return { results, freedBytes }
}

/** Normalize and bound the id list accepted by the delete route. */
export function normalizeIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw httpError('sessions/bad-request', 'ids must be a non-empty array')
  }
  const seen = new Set()
  const ids = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw httpError('sessions/bad-request', 'every id must be a non-empty string')
    }
    const id = entry.trim()
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  if (ids.length > MAX_DELETE_IDS) {
    throw httpError('sessions/bad-request', 'at most ' + String(MAX_DELETE_IDS) + ' ids per request')
  }
  return ids
}
