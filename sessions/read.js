/**
 * Read one archived session's log without resuming its Agent.
 *
 * The read uses sessionPersistence.open(id, 'read'): read access never takes
 * ownership, never appends, and never enters the session registry. Projection
 * happens here, in the host, so the browser receives bounded plain text only.
 *
 * Archived sessions are immutable, so the viewer only needs two directions:
 * the newest page ('tail') and older pages ('before'). The forward 'after'
 * cursor is kept for callers that page from the start and for the oversized
 * fallback, where the host refuses to materialize the whole log.
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
/** Above this artifact size, a tail view pages forward instead of reading all. */
export const MAX_TAIL_BYTES = 32 * 1024 * 1024

function parseNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null) return fallback
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(number) || number < 0) {
    throw httpError('sessions/bad-request', 'after, before and limit must be non-negative integers')
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
    if (body.text === '') return null
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
    if (body.text === '') return null
    const failed = data.message && data.message.isError === true
    return { seq: event.seq, time: event.time, role: 'tool', ...body, ...(failed ? { isError: true } : {}) }
  }
  return null
}

/**
 * Project one raw slice into bounded rows.
 * @param page - raw events in ascending seq order.
 * @returns visible rows and the bytes they occupy.
 */
function projectPage(page) {
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
  return { events, bytes }
}

/** Session header facts shared by every page shape. */
function sessionOf(snapshot) {
  return {
    id: snapshot.header.id,
    cwd: snapshot.header.cwd,
    createdAt: snapshot.header.createdAt,
    eventCount: snapshot.eventCount,
  }
}

/**
 * Read one page of an archived session.
 * @param services - host services (sessionPersistence is required).
 * @param request - { id, after?, before?, tail?, limit? }.
 * @returns header facts plus projected events and the next cursors.
 */
export async function readArchivedSession(services, request) {
  const id = typeof request.id === 'string' ? request.id.trim() : ''
  if (id === '') throw httpError('sessions/bad-request', 'id is required')
  const after = parseNonNegativeInteger(request.after, 0)
  const before = request.before === undefined || request.before === null
    ? undefined
    : parseNonNegativeInteger(request.before, undefined)
  const requested = parseNonNegativeInteger(request.limit, DEFAULT_READ_LIMIT)
  const limit = Math.min(requested === 0 ? DEFAULT_READ_LIMIT : requested, MAX_READ_LIMIT)
  const tail = request.tail === true

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
    if (tail) {
      // JSONL stat does not expose an event count, so the newest page is
      // obtained by reading the log once and projecting backwards. Only the
      // rows that will be returned are materialized; the raw array is what the
      // backend already parsed for any read. Oversized logs fall back to
      // forward paging so an archive view cannot balloon host memory.
      const sizeBytes = Number.isFinite(snapshot.sizeBytes) ? snapshot.sizeBytes : undefined
      if (sizeBytes !== undefined && sizeBytes <= MAX_TAIL_BYTES) {
        const slice = await handle.read(0, Number.MAX_SAFE_INTEGER)
        const raw = Array.isArray(slice && slice.events) ? slice.events : []
        const events = []
        let bytes = 0
        let sawOlder = false
        for (let index = raw.length - 1; index >= 0; index -= 1) {
          const row = projectEvent(raw[index])
          if (row === null) continue
          const size = JSON.stringify(row).length
          if (bytes + size > MAX_RESPONSE_BYTES) {
            sawOlder = index > 0
            break
          }
          bytes += size
          events.unshift(row)
          if (events.length >= limit) {
            sawOlder = index > 0
            break
          }
        }
        const previousAfter = sawOlder && events.length > 0 && events[0].seq > 0 ? events[0].seq : null
        return {
          session: sessionOf(snapshot),
          events,
          nextAfter: null,
          previousAfter,
          hasMore: previousAfter !== null,
          pageBytes: bytes,
        }
      }
      const slice = await handle.read(0, limit + 1)
      const raw = Array.isArray(slice && slice.events) ? slice.events : []
      const page = raw.slice(0, limit)
      const projected = projectPage(page)
      const lastRawSeq = page.length > 0 ? page[page.length - 1].seq : 0
      const nextAfter = raw.length > limit || projected.events.length < page.length ? lastRawSeq + 1 : null
      return {
        session: sessionOf(snapshot),
        events: projected.events,
        nextAfter,
        previousAfter: null,
        hasMore: nextAfter !== null,
        tailFallback: true,
        pageBytes: projected.bytes,
      }
    }

    if (before !== undefined) {
      const start = Math.max(0, before - limit)
      const slice = await handle.read(start, Math.min(limit, before - start))
      const raw = Array.isArray(slice && slice.events) ? slice.events : []
      const projected = projectPage(raw)
      const previousAfter = start > 0 ? start : null
      return {
        session: sessionOf(snapshot),
        events: projected.events,
        nextAfter: null,
        previousAfter,
        hasMore: previousAfter !== null,
        pageBytes: projected.bytes,
      }
    }

    // One extra event tells us whether another page exists.
    const slice = await handle.read(after, limit + 1)
    const raw = Array.isArray(slice && slice.events) ? slice.events : []
    const page = raw.slice(0, limit)
    const hasMore = raw.length > limit
    const projected = projectPage(page)
    // The cursor advances past every raw event consumed by this page, so a page
    // made only of skipped log events still moves forward.
    const lastRawSeq = page.length > 0 ? page[page.length - 1].seq : after
    const cutBySize = projected.events.length < page.length
    const nextAfter = (hasMore || cutBySize) ? lastRawSeq + 1 : null
    return {
      session: sessionOf(snapshot),
      events: projected.events,
      nextAfter,
      previousAfter: null,
      hasMore: hasMore || cutBySize,
      pageBytes: projected.bytes,
    }
  } finally {
    try {
      await handle.close()
    } catch {
      // Closing a read handle is idempotent; a failure here changes nothing.
    }
  }
}
