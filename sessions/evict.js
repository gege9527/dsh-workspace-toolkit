/**
 * In-memory cleanup after a session's log files are gone.
 *
 * Deleting the files alone leaves three host-side facts pointing at a session
 * that no longer exists: the Workspace registry's header index (`headers`,
 * session path caches), the owning Workspace's durable `sessionIds` record, and
 * the client Session catalog. The Workspace record is the only one with a
 * public writer, so this module detaches the session first and then prunes the
 * registry's private indexes. The detach emits `domain/changed`, which makes
 * the Workspace feed push a upsert whose `sessionIds` no longer name the
 * deleted row; the browser half refreshes the Session catalog separately.
 *
 * The private maps are probed defensively: a DSH front-end update that renames
 * one must not make deletion fail after the files are already removed.
 */

/**
 * Detach one session from its Workspace record and prune the registry index.
 * @param services - host services (workspaceRegistry is required).
 * @param sessionId - the deleted session.
 * @returns what was found and cleaned.
 */
export async function forgetSession(services, sessionId) {
  const registry = services && services.workspaceRegistry
  if (registry === undefined || registry === null) return { detached: false, indexed: false }

  let detached = false
  if (typeof registry.list === 'function') {
    let entities = []
    try {
      entities = registry.list()
    } catch {
      entities = []
    }
    for (const entity of entities) {
      if (entity === undefined || entity === null) continue
      const sessionIds = entity.sessionIds
      if (!Array.isArray(sessionIds) || !sessionIds.includes(sessionId)) continue
      if (typeof entity.detachSession === 'function') {
        await entity.detachSession(sessionId)
        detached = true
      }
      break
    }
  }

  let indexed = false
  for (const name of ['headers', 'sessionPaths', 'invalidSessionPaths', 'missingSessionPaths']) {
    const index = registry[name]
    if (index !== undefined && index !== null && typeof index.delete === 'function') {
      index.delete(sessionId)
      indexed = true
    }
  }
  return { detached, indexed }
}

/**
 * Force the SessionStore to release one live entry after its Agent is gone.
 *
 * A Session can stay in the store after an archived Agent is disposed — most
 * commonly because a browser still holds the entry, or because the entry was
 * restored by another owner. Deleting an archived Session must not fail just
 * because that idle entry outlived the view. The store's private entry exposes
 * its own single-shot detach; use it only after the Agent and liveness checks.
 * @param services - host services (sessions is required).
 * @param sessionId - candidate id.
 * @returns whether a detach capability was found and invoked.
 */
export async function forceDetachLiveSession(services, sessionId) {
  const sessions = services && services.sessions
  if (sessions === undefined || sessions === null) return false
  const store = sessions.store
  if (store === undefined || store === null || typeof store.get !== 'function') return false
  let entry
  try {
    entry = store.get(sessionId)
  } catch {
    return false
  }
  if (entry === undefined || entry === null || typeof entry.detach !== 'function') return false
  try {
    entry.detach()
    return true
  } catch {
    return false
  }
}

/**
 * Drop any live Session entry for an id once its owning Agent is gone.
 * @param services - host services (sessions is required).
 * @param sessionId - candidate id.
 * @param timeoutMs - how long to wait for the owner's disposal to land.
 * @returns whether the store still holds the session.
 */
export async function waitForSessionGone(services, sessionId, timeoutMs = 2000) {
  const sessions = services && services.sessions
  if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return false
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (sessions.get(sessionId) === undefined) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return sessions.get(sessionId) === undefined
}
