/**
 * Host half of dsh-workspace-toolkit.
 *
 * Serves the browser half facts it cannot derive by itself:
 *   1. Where the DSH attachment store lives (<DSH_HOME>/attachments/v1).
 *   2. The paste-to-file threshold.
 *   3. Workspace path migration (preflight / prepare / rollback / status) and
 *      boot-time completion of a migration that could not finish in-process.
 *
 * Zero dependencies, no build step: plain ESM, node: builtins only.
 */
import { join } from 'node:path'
import {
  completePendingOnBoot, preflight, prepare, retryComplete, rollback, status, workspaceStatus,
} from './migration/index.js'
import { detectRegistryCompat } from './migration/registry.js'
import { resolveDshHome } from './migration/paths.js'
import { readJsonBody, sendJson, localityViolation } from './sessions/http.js'
import { deleteArchivedSessions, normalizeIds } from './sessions/delete.js'
import { readArchivedSession } from './sessions/read.js'

export const name = 'workspace-toolkit'

/** Default paste-to-file threshold, mirroring web deepseek.com (2000 chars). */
export const DEFAULT_PASTE_TO_FILE_LIMIT = 2000

/** Paste text beyond this byte size cannot be restored into the composer. */
export const MAX_PASTE_RESTORE_BYTES = 614400

/** HTTP endpoint for workspace migration. */
export const MIGRATION_API_PATH = '/api/workspace-toolkit/migrate'

/** HTTP endpoint deleting archived sessions. */
export const SESSION_DELETE_API_PATH = '/api/workspace-toolkit/sessions/delete'

/** HTTP endpoint reading one archived session, read-only. */
export const SESSION_READ_API_PATH = '/api/workspace-toolkit/sessions/read'

export { resolveDshHome }

function json(response, statusCode, value) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value) + '\n')
}

function errorPayload(error) {
  return {
    ok: false,
    code: error && error.code ? error.code : 'migration/internal',
    message: String(error && error.message ? error.message : error),
    ...(error && error.details !== undefined ? { details: error.details } : {}),
    ...(error && error.migrationId !== undefined ? { migrationId: error.migrationId } : {}),
  }
}

async function readBody(request, limit) {
  const chunks = []
  let total = 0
  await new Promise((resolve, reject) => {
    request.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', resolve)
    request.on('error', reject)
  })
  return Buffer.concat(chunks).toString('utf8')
}

function planForClient(plan) {
  return {
    workspaceId: plan.workspaceId,
    workspaceTitle: plan.workspaceTitle,
    oldPath: plan.oldPath,
    newPath: plan.newPath,
    sessionCount: plan.sessionCount,
    accountedCount: plan.accountedCount,
    subagentCount: plan.subagentCount,
    archivedCount: plan.archivedCount,
    totalBytes: plan.totalBytes,
    completionMode: plan.completionMode,
    compat: plan.compat,
    sessions: plan.sessions.map(session => ({
      id: session.id,
      accounted: session.accounted,
      archived: session.archived,
      sizeBytes: session.sizeBytes,
    })),
  }
}

function createHandler(services, dshHome, logger) {
  return async function handler(request, response) {
    try {
      if (request.method !== 'POST') {
        return json(response, 405, { ok: false, code: 'migration/method', message: 'POST required' })
      }
      const raw = await readBody(request, 256 * 1024)
      let body
      try {
        body = raw === '' ? {} : JSON.parse(raw)
      } catch {
        return json(response, 400, { ok: false, code: 'migration/bad-request', message: 'invalid JSON body' })
      }
      const action = body.action
      if (action === 'preflight') {
        if (typeof body.workspaceId !== 'string' || body.workspaceId === '') {
          return json(response, 400, { ok: false, code: 'migration/bad-request', message: 'workspaceId is required' })
        }
        if (typeof body.targetPath !== 'string' || body.targetPath === '') {
          return json(response, 400, { ok: false, code: 'migration/bad-request', message: 'targetPath is required' })
        }
        const plan = await preflight(services, dshHome, body.workspaceId, body.targetPath)
        return json(response, 200, { ok: true, action, plan: planForClient(plan) })
      }
      if (action === 'prepare') {
        if (typeof body.workspaceId !== 'string' || body.workspaceId === '') {
          return json(response, 400, { ok: false, code: 'migration/bad-request', message: 'workspaceId is required' })
        }
        if (typeof body.targetPath !== 'string' || body.targetPath === '') {
          return json(response, 400, { ok: false, code: 'migration/bad-request', message: 'targetPath is required' })
        }
        const result = await prepare(services, dshHome, body.workspaceId, body.targetPath, {
          unarchive: body.unarchive === true,
        })
        return json(response, 200, {
          ok: true,
          action,
          migrationId: result.journal.id,
          state: result.journal.state,
          completionMode: result.completionMode,
          ...(result.warning ? { warning: result.warning } : {}),
          ...(result.journal.error ? { message: result.journal.error } : {}),
        })
      }
      if (action === 'rollback') {
        const result = await rollback(services, dshHome, body.migrationId)
        return json(response, 200, {
          ok: true,
          action,
          migrationId: result.journal.id,
          state: result.state,
        })
      }
      if (action === 'retry-complete') {
        const result = await retryComplete(services, dshHome, body.migrationId)
        return json(response, 200, {
          ok: true,
          action,
          migrationId: result.journal.id,
          state: result.journal.state,
          completionMode: result.completionMode,
          ...(result.journal.error ? { message: result.journal.error } : {}),
        })
      }
      if (action === 'workspace-status') {
        if (typeof body.workspaceId !== 'string' || body.workspaceId === '') {
          return json(response, 400, { ok: false, code: 'migration/bad-request', message: 'workspaceId is required' })
        }
        const workspaces = await workspaceStatus(services.workspaceRegistry, body.workspaceId)
        return json(response, 200, { ok: true, action, workspaces })
      }
      if (action === 'status') {
        const snapshot = await status(dshHome)
        return json(response, 200, {
          ok: true,
          action,
          journals: snapshot.journals,
          compat: detectRegistryCompat(services.workspaceRegistry),
        })
      }
      return json(response, 400, { ok: false, code: 'migration/bad-request', message: 'unknown action: ' + String(action) })
    } catch (error) {
      if (logger && logger.warn) {
        logger.warn('[workspace-toolkit] migration request failed: ' + String(error && error.message ? error.message : error))
      }
      return json(response, 200, errorPayload(error))
    }
  }
}


/** One JSON error body shared by the session endpoints. */
function sessionErrorPayload(error) {
  return {
    ok: false,
    code: error && typeof error.code === 'string' && error.code !== '' ? error.code : 'sessions/internal',
    message: String(error && error.message ? error.message : error),
    ...(error && error.details !== undefined ? { details: error.details } : {}),
  }
}

/**
 * Guard one session request: local origin only, POST only.
 * @returns the parsed body when the request may proceed, otherwise null after
 * writing the refusal.
 */
async function guardSessionRequest(request, response) {
  const violation = localityViolation(request)
  if (violation !== null) {
    sendJson(response, 403, { ok: false, code: violation, message: 'session endpoints accept local requests only' })
    return null
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { ok: false, code: 'sessions/method', message: 'POST required' })
    return null
  }
  try {
    return await readJsonBody(request)
  } catch (error) {
    sendJson(response, 400, sessionErrorPayload(error))
    return null
  }
}

function createSessionDeleteHandler(services, dshHome, logger) {
  return async function handler(request, response) {
    const body = await guardSessionRequest(request, response)
    if (body === null) return
    try {
      const ids = normalizeIds(body.ids)
      const outcome = await deleteArchivedSessions(services, dshHome, ids)
      sendJson(response, 200, { ok: true, results: outcome.results, freedBytes: outcome.freedBytes })
    } catch (error) {
      if (logger && logger.warn) {
        logger.warn('[workspace-toolkit] session delete failed: ' + String(error && error.message ? error.message : error))
      }
      sendJson(response, 200, sessionErrorPayload(error))
    }
  }
}

function createSessionReadHandler(services, logger) {
  return async function handler(request, response) {
    const body = await guardSessionRequest(request, response)
    if (body === null) return
    try {
      const result = await readArchivedSession(services, {
        id: body.id,
        after: body.after,
        limit: body.limit,
      })
      sendJson(response, 200, { ok: true, ...result })
    } catch (error) {
      if (logger && logger.warn) {
        logger.warn('[workspace-toolkit] session read failed: ' + String(error && error.message ? error.message : error))
      }
      sendJson(response, 200, sessionErrorPayload(error))
    }
  }
}

export function apply(ctx) {
  const dshHome = resolveDshHome()
  const attachmentsRoot = join(dshHome, 'attachments', 'v1')
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: '__DSH_WORKSPACE_TOOLKIT__',
      value: {
        attachmentsRoot,
        pasteToFileLimit: DEFAULT_PASTE_TO_FILE_LIMIT,
        maxPasteRestoreBytes: MAX_PASTE_RESTORE_BYTES,
        sessionDeleteApiPath: SESSION_DELETE_API_PATH,
        sessionReadApiPath: SESSION_READ_API_PATH,
      },
    })
  })

  let bootCompletionStarted = false
  ctx.inject(['workspaceRegistry', 'sessionPersistence'], (scope) => {
    if (bootCompletionStarted) return
    bootCompletionStarted = true
    const services = {
      workspaceRegistry: scope.workspaceRegistry,
      sessionPersistence: scope.sessionPersistence,
      sessions: ctx.get('sessions'),
      waterfall: typeof ctx.waterfall === 'function' ? ((...args) => ctx.waterfall(...args)) : undefined,
    }
    Promise.resolve()
      .then(() => completePendingOnBoot(services, dshHome, ctx.logger))
      .catch((error) => {
        const logger = ctx.logger
        if (logger && logger.warn) logger.warn('[workspace-toolkit] boot migration scan failed: ' + String(error))
      })
  })

  ctx.inject(['webServer', 'workspaceRegistry', 'sessionPersistence', 'sessions'], (scope) => {
    const services = {
      workspaceRegistry: scope.workspaceRegistry,
      sessionPersistence: scope.sessionPersistence,
      sessions: scope.sessions,
      waterfall: typeof ctx.waterfall === 'function' ? ((...args) => ctx.waterfall(...args)) : undefined,
    }
    let queue = Promise.resolve()
    const enqueue = (task) => {
      const run = queue.then(task, task)
      queue = run.then(() => undefined, () => undefined)
      return run
    }
    const handler = createHandler(services, dshHome, ctx.logger)
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: MIGRATION_API_PATH,
      handler: (request, response) => enqueue(() => handler(request, response)),
    }), 'workspace-toolkit:migration-api')

    const deleteHandler = createSessionDeleteHandler(services, dshHome, ctx.logger)
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: SESSION_DELETE_API_PATH,
      handler: (request, response) => enqueue(() => deleteHandler(request, response)),
    }), 'workspace-toolkit:session-delete-api')

    const readHandler = createSessionReadHandler(services, ctx.logger)
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: SESSION_READ_API_PATH,
      handler: readHandler,
    }), 'workspace-toolkit:session-read-api')
  })
}