/**
 * Delete archived sessions: remove the log directory, then clear every derived
 * fact that would otherwise keep the row visible.
 *
 * Order is fixed: validate archived -> resolve the artifact -> reject running
 * work -> release an idle Agent -> delete files -> clear the projection cache
 * -> unarchive -> detach the Workspace record + prune the registry header
 * index. Files go first so a failed cleanup leaves the session archived (and
 * therefore retryable) instead of surfacing a log-less conversation.
 *
 * A retry is idempotent: a session whose artifact is already gone still gets
 * its archive flag and Workspace accounting cleaned, and reports success.
 */
import { httpError } from './http.js'
import { forceDetachLiveSession, forgetSession, waitForSessionGone } from './evict.js'
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
 * Resolve a session's directory without turning a missing artifact into a
 * failed request; an earlier deletion legitimately leaves no directory.
 * @param services - host services.
 * @param dshHome - DSH config root.
 * @param sessionId - stored session id.
 * @returns the resolved directory or `{ missing: true }`.
 */
async function probeSessionDir(services, dshHome, sessionId) {
  try {
    return { missing: false, resolved: await resolveSessionDir(services, dshHome, sessionId) }
  } catch (error) {
    if (codeOf(error) === 'sessions/not-found') return { missing: true, resolved: null }
    throw error
  }
}

/** The Agent bound to a session, when the Agent registry is available. */
function agentOf(services, sessionId) {
  const agents = services && services.agents
  return agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
}

/** Remove the projection-cache record for one id; cache loss is only a warning. */
async function clearCache(dshHome, sessionId) {
  try {
    return await removeProjectionCache(dshHome, sessionId)
  } catch (error) {
    return ['projection cache: ' + messageOf(error)]
  }
}

/**
 * Delete one archived session.
 * @param services - host services (workspaceRegistry, sessionPersistence, sessions, agents).
 * @param dshHome - DSH config root.
 * @param sessionId - candidate id.
 * @param archived - archived id set captured once per request.
 * @returns one result plus the released bytes.
 */
async function deleteOne(services, dshHome, sessionId, archived) {
  let stage = 'validate'
  try {
    if (!archived.has(sessionId)) {
      // A prior request may have removed the artifact before its archive flag
      // was cleared; only that state is a successful retry, never a normal
      // unarchived session.
      const probe = await probeSessionDir(services, dshHome, sessionId)
      if (!probe.missing) {
        throw httpError('sessions/not-archived', 'session ' + sessionId + ' is not archived')
      }
      stage = 'projection-cache'
      await clearCache(dshHome, sessionId)
      stage = 'unarchive'
      await services.workspaceRegistry.unarchiveSession(sessionId)
      stage = 'workspace'
      const cleanup = await forgetSession(services, sessionId)
      return {
        result: {
          id: sessionId,
          ok: true,
          stage: 'already-gone',
          bytes: 0,
          alreadyGone: true,
          ...(cleanup.detached ? { detached: true } : {}),
        },
        bytes: 0,
      }
    }

    stage = 'resolve-path'
    const probe = await probeSessionDir(services, dshHome, sessionId)
    const resolved = probe.resolved
    const missing = probe.missing

    stage = 'activity'
    const agent = agentOf(services, sessionId)
    if (agent !== undefined && agent !== null) {
      if (agent.status === 'running' && typeof agent.dispose !== 'function') {
        throw httpError('sessions/active', 'session ' + sessionId + ' is still running')
      }
      if (typeof agent.dispose === 'function') {
        // An archived Session may keep its Agent resident after a stop, and a
        // race may still report it running. Deleting owns the Session now, so
        // dispose it (stops the loop, removes the store entry, emits
        // session/disposed) before touching files.
        try {
          await agent.dispose()
        } catch {
          // The liveness re-checks below are the real gate.
        }
        await waitForSessionGone(services, sessionId, 3000)
      }
    }
    let live = services.sessions && typeof services.sessions.get === 'function'
      ? services.sessions.get(sessionId)
      : undefined
    let releasedLive = false
    if (live !== undefined && live !== null) {
      // An idle entry can outlive its Agent (a browser retain, or a restore
      // owned elsewhere). Deletion owns the Session now, so release the entry
      // through its own single-shot detach and re-check before touching files.
      if (forceDetachLiveSession(services, sessionId)) {
        releasedLive = true
        await waitForSessionGone(services, sessionId, 1000)
      }
      live = services.sessions.get(sessionId)
    }
    if (live !== undefined && live !== null) {
      throw httpError(
        'sessions/active',
        'session ' + sessionId + ' is still open in a client; close it and retry',
      )
    }

    let bytes = 0
    if (!missing) {
      stage = 'remove-files'
      bytes = await removeSessionDirectory(resolved.dir)
    }
    stage = 'projection-cache'
    const warnings = await clearCache(dshHome, sessionId)

    stage = 'unarchive'
    await services.workspaceRegistry.unarchiveSession(sessionId)
    stage = 'workspace'
    const cleanup = await forgetSession(services, sessionId)

    return {
      result: {
        id: sessionId,
        ok: true,
        stage: 'done',
        bytes,
        ...(missing ? { alreadyGone: true } : {}),
        ...(releasedLive ? { releasedLive: true } : {}),
        ...(cleanup.detached ? { detached: true } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      bytes,
    }
  } catch (error) {
    const filesRemoved = stage === 'projection-cache' || stage === 'unarchive' || stage === 'workspace'
    const note = filesRemoved
      ? ' (the logs were removed; retry the deletion to finish workspace cleanup)'
      : ''
    return {
      result: {
        id: sessionId,
        ok: false,
        stage,
        filesRemoved,
        error: { code: codeOf(error), message: messageOf(error) + note },
      },
      bytes: 0,
    }
  }
}

/**
 * Delete every requested archived session, independently per id.
 * @param services - host services (workspaceRegistry, sessionPersistence, sessions, agents).
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
