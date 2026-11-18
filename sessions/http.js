/**
 * Shared HTTP plumbing for the archived-session endpoints.
 *
 * Zero dependencies: plain node: builtins only. Every failure carries a stable
 * `code` so the browser half can map it to localized copy.
 */

/** Request bodies are tiny id lists or cursors; anything larger is a bug. */
export const MAX_BODY_BYTES = 64 * 1024

/** Error with a stable machine code. */
export function httpError(code, message, extra) {
  const error = new Error(message)
  error.code = code
  if (extra !== undefined) error.details = extra
  return error
}

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read and parse a JSON request body, bounded by `limit` bytes.
 * @param request - the incoming request stream.
 * @param limit - maximum accepted byte length.
 * @returns the parsed body, or `{}` for an empty body.
 */
export async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  const chunks = []
  let total = 0
  await new Promise((resolve, reject) => {
    request.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        reject(httpError('sessions/body-too-large', 'request body exceeds ' + String(limit) + ' bytes'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', resolve)
    request.on('error', reject)
  })
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw httpError('sessions/bad-json', 'invalid JSON body')
  }
  if (!isJsonObject(parsed)) throw httpError('sessions/bad-json', 'JSON body must be an object')
  return parsed
}

/**
 * Write one JSON response.
 * @param response - the outgoing response.
 * @param statusCode - HTTP status.
 * @param value - JSON-serializable payload.
 */
export function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value) + '\n')
}

/** Loopback hostnames a local DSH page is served from. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Strip an optional port from a Host header value. */
function hostnameOf(host) {
  if (typeof host !== 'string' || host === '') return ''
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    return close === -1 ? '' : host.slice(0, close + 1)
  }
  const colon = host.lastIndexOf(':')
  return colon === -1 ? host : host.slice(0, colon)
}

/**
 * Refuse anything that did not come from the local page. The web server does
 * not hand plugins the peer scope, so the plugin re-checks the two headers a
 * browser always sends.
 * @param request - the incoming request.
 * @returns null when the request is local, otherwise the refusal code.
 */
export function localityViolation(request) {
  const host = request.headers && request.headers.host
  const hostname = hostnameOf(host)
  if (!LOOPBACK_HOSTS.has(hostname)) return 'sessions/not-local'
  const origin = request.headers && request.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    let originHost
    try {
      originHost = new URL(origin).host
    } catch {
      return 'sessions/bad-origin'
    }
    if (originHost.toLowerCase() !== String(host).toLowerCase()) return 'sessions/bad-origin'
  }
  return null
}
