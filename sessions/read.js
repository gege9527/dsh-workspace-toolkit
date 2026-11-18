/**
 * Read one archived session's log without resuming its Agent.
 *
 * The read uses `sessionPersistence.open(id, 'read')`: read access never takes
 * ownership, never appends, and never enters the session registry. Projection
 * happens here, in the host, so the browser receives bounded plain text only.
 */
import { httpError } from './http.js'

/** Default page size. */
export const DEFAULT_READ_LIMIT = 50
/** Hard cap for one page. */
export const MAX_READ_LIMIT = 200
/** One event's body is cut here, with an explicit marker. */
export const MAX_BODY_CHARS = 8 * 1024
/** One response stays below this serialized size. */
export const MAX_RESPONSE_BYTES = 1024 * 1024

function parseNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null) return fallback
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(number) || number < 0) {
    throw httpError('sessions/bad-request', 'after and limit must be non-negative integers')
  }
  return number
}

function truncate(text) {
  if (text.length <= MAX_BODY_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_BODY_CHARS) + '\n…[truncated]', truncated: true }
}

/** Join the visible text blocks of one message. */
function textOf(message) {
  const parts = []
  const content = message && Array.isArray(message.content) ? message.content : []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Tool calls carried by one assistant message. */
function toolCallsOf(message) {
  const calls = []
  const content = message && Array.isArray(message.content) ? message.content : []
  for (const block of content) {
    if (!block || typeof block !== 'object' || block.type !== 'tool-call') continue
    if (typeof block.name !== 'string') continue
    calls.push({ name: block.name, arguments: typeof block.arguments === 'string' ? block.arguments : '' })
  }
  return calls
}

/**
 * Turn one stored event into a render row, or null for log-only events.
 * @param event - one session event.
 * @returns the projection row.
 */
export function projectEvent(event) {
  if (event === null || typeof event !== 'object') return null
  const data = event.data && typeof event.data === 'object' ? event.data : {}
  if (event.type === 'user/message') {
    const body = truncate(textOf(data.message))
    return { seq: event.seq, time: event.time, role: 'user', ...body }
  }
  if (event.type === 'assistant/message') {
    const body = truncate(textOf(data.message))
    const toolCalls = toolCallsOf(data.message)
    if (body.text === '' && toolCalls.length === 0) return null
    return { seq: event.seq, time: event.time, role: 'assistant', ...body, ...(toolCalls.length > 0 ? { toolCalls } : {}) }
  }
  if (event.type === 'tool/result') {
    const body = truncate(textOf(data.message))
    const failed = data.message && data.message.isError === true
    return { seq: event.seq, time: event.time, role: 'tool', ...body, ...(failed ? { isError: true } : {}) }
  }
  return null
}

/**
 * Read one page of an archived session.
 * @param services - host services (sessionPersistence is required).
 * @param request - `{ id, after, limit }`.
 * @returns header facts plus projected events and the next cursor.
 */
export async function readArchivedSession(services, request) {
  const id = typeof request.id === 'string' ? request.id.trim() : ''
  if (id === '') throw httpError('sessions/bad-request', 'id is required')
  const after = parseNonNegativeInteger(request.after, 0)
  const requested = parseNonNegativeInteger(request.limit, DEFAULT_READ_LIMIT)
  const limit = Math.min(requested === 0 ? DEFAULT_READ_LIMIT : requested, MAX_READ_LIMIT)

  let snapshot
  try {
    snapshot = await services.sessionPersistence.stat(id)
  } catch (error) {
    throw httpError('sessions/stat-failed', String(error && error.message ? error.message : error))
  }
  if (snapshot === undefined) throw httpError('sessions/not-found', 'session ' + id + ' was not found')
  if (snapshot.formatStatus === 'migration-required') {
    throw httpError('sessions/migration-required', 'session format must be migrated before it can be read')
  }

  let handle
  try {
    handle = await services.sessionPersistence.open(id, 'read')
  } catch (error) {
    const name = error && error.name ? String(error.name) : ''
    const message = String(error && error.message ? error.message : error)
    if (name === 'SessionAlreadyOwnedError') throw httpError('sessions/owned', message)
    if (name === 'SessionPersistenceNotFoundError') throw httpError('sessions/not-found', message)
    if (name === 'SessionFormatUnsupportedError') throw httpError('sessions/migration-required', message)
    throw httpError('sessions/open-failed', message)
  }

  try {
    // One extra event tells us whether another page exists.
    const slice = await handle.read(after, limit + 1)
    const raw = Array.isArray(slice && slice.events) ? slice.events : []
    const page = raw.slice(0, limit)
    const hasMore = raw.length > limit
    const events = []
    let bytes = 0
    for (const event of page) {
      const row = projectEvent(event)
      if (row === null) continue
      const size = JSON.stringify(row).length
      if (bytes + size > MAX_RESPONSE_BYTES) break
      bytes += size
      events.push(row)
    }
    // The cursor advances past every raw event consumed by this page, so a page
    // made only of skipped log events still moves forward.
    const lastRawSeq = page.length > 0 ? page[page.length - 1].seq : after
    const cutBySize = events.length < page.length
    const nextAfter = (hasMore || cutBySize) ? lastRawSeq + 1 : null
    return {
      session: {
        id: snapshot.header.id,
        cwd: snapshot.header.cwd,
        createdAt: snapshot.header.createdAt,
        eventCount: snapshot.eventCount,
      },
      events,
      nextAfter,
      hasMore: hasMore || cutBySize,
      pageBytes: bytes,
    }
  } finally {
    try {
      await handle.close()
    } catch {
      // Closing a read handle is idempotent; a failure here changes nothing.
    }
  }
}
