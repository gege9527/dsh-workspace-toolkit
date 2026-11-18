/**
 * Unit tests for the archived-session host services.
 *
 * Run with: node --test test/
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { deleteArchivedSessions, normalizeIds } from '../sessions/delete.js'
import { projectEvent, readArchivedSession } from '../sessions/read.js'
import { localityViolation, MAX_BODY_BYTES } from '../sessions/http.js'

/** Build a temp DSH home with one stored session artifact and its cache record. */
async function makeHome(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wst-test-'))
  const sessionId = options.sessionId ?? 'session-1'
  const dir = join(home, 'sessions', 'project-key', sessionId)
  await mkdir(dir, { recursive: true })
  const artifact = join(dir, 'session.v4.jsonl.zstd')
  await writeFile(artifact, 'log-bytes')
  if (options.cacheUnit === true) {
    await mkdir(join(home, 'storages'), { recursive: true })
    await writeFile(join(home, 'storages', 'session_projcache.json'), JSON.stringify({
      unit: { version: 3 },
      global: {},
      tables: { sessions: { [sessionId]: { title: 'cached' }, other: { title: 'keep' } } },
    }))
  }
  if (options.cacheDir === true) {
    const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(join(cacheDir, sessionId + '.json'), JSON.stringify({ version: 7, record: {} }))
  }
  return { home, sessionId, dir, artifact }
}

function fakeServices({ home, sessionId, archived = true, events = [], formatStatus = 'current', openError = null, statError = null }) {
  const calls = { unarchive: [], stat: 0, open: 0, live: [] }
  return {
    calls,
    services: {
      workspaceRegistry: {
        archivedSessionIds: archived ? [sessionId] : [],
        async unarchiveSession(id) { calls.unarchive.push(id) },
      },
      sessionPersistence: {
        async stat(id) {
          calls.stat += 1
          if (id !== sessionId) return undefined
          if (statError !== null) throw statError
          return {
            header: { version: 4, id, createdAt: 1700000000000, cwd: '/tmp/project', isSeeded: false },
            formatStatus,
            revision: 'rev',
            eventCount: events.length,
            location: { kind: 'jsonl', path: join(home, 'sessions', 'project-key', id, 'session.v4.jsonl.zstd') },
          }
        },
        async open(id, access) {
          calls.open += 1
          assert.equal(access, 'read')
          if (openError !== null) throw openError
          return {
            id,
            header: { version: 4, id, createdAt: 1, cwd: '/tmp/project', isSeeded: false },
            async read(offset, length) {
              return { eventState: 'detached', events: events.slice(offset, offset + length) }
            },
            async close() {},
          }
        },
      },
      sessions: { get(id) { calls.live.push(id); return undefined } },
    },
  }
}

test('deletes an archived session, unarchives first and clears both caches', async () => {
  const env = await makeHome({ cacheUnit: true, cacheDir: true })
  const { services, calls } = fakeServices({ home: env.home, sessionId: env.sessionId })
  const outcome = await deleteArchivedSessions(services, env.home, [env.sessionId])
  assert.equal(outcome.results.length, 1)
  assert.equal(outcome.results[0].ok, true)
  assert.deepEqual(calls.unarchive, [env.sessionId])
  await assert.rejects(stat(env.dir))
  const unit = JSON.parse(await readFile(join(env.home, 'storages', 'session_projcache.json'), 'utf8'))
  assert.equal(unit.tables.sessions[env.sessionId], undefined)
  assert.deepEqual(unit.tables.sessions.other, { title: 'keep' })
  await assert.rejects(stat(join(env.home, 'storages', 'session_projcache', 'sessions', env.sessionId + '.json')))
  await rm(env.home, { recursive: true, force: true })
})

test('refuses a session that is not archived without touching the registry', async () => {
  const env = await makeHome()
  const { services, calls } = fakeServices({ home: env.home, sessionId: env.sessionId, archived: false })
  const outcome = await deleteArchivedSessions(services, env.home, [env.sessionId])
  assert.equal(outcome.results[0].ok, false)
  assert.equal(outcome.results[0].error.code, 'sessions/not-archived')
  assert.deepEqual(calls.unarchive, [])
  assert.ok(await stat(env.artifact))
  await rm(env.home, { recursive: true, force: true })
})

test('refuses a session with live agent work', async () => {
  const env = await makeHome()
  const { services, calls } = fakeServices({ home: env.home, sessionId: env.sessionId })
  services.sessions.get = () => ({ id: env.sessionId })
  const outcome = await deleteArchivedSessions(services, env.home, [env.sessionId])
  assert.equal(outcome.results[0].error.code, 'sessions/active')
  assert.deepEqual(calls.unarchive, [])
  await rm(env.home, { recursive: true, force: true })
})

test('reports a stat failure per id and keeps going', async () => {
  const env = await makeHome()
  const { services } = fakeServices({ home: env.home, sessionId: env.sessionId, statError: new Error('boom') })
  services.workspaceRegistry.archivedSessionIds = [env.sessionId, 'missing']
  // 'missing' still resolves through the archived gate first, so the failure
  // order stays validate -> stat.
  const outcome = await deleteArchivedSessions(services, env.home, [env.sessionId, 'missing'])
  assert.equal(outcome.results.length, 2)
  assert.equal(outcome.results[0].ok, false)
  assert.equal(outcome.results[0].error.code, 'sessions/stat-failed')
  assert.match(outcome.results[0].error.message, /unarchived but its logs are still on disk/)
  // 'missing' passed the archived gate (the fake list names it) and then found
  // no stored artifact, which is the not-found path.
  assert.equal(outcome.results[1].error.code, 'sessions/not-found')
  await rm(env.home, { recursive: true, force: true })
})

test('rejects an empty or malformed id list', () => {
  assert.throws(() => normalizeIds([]), /non-empty array/)
  assert.throws(() => normalizeIds([1]), /non-empty string/)
  assert.deepEqual(normalizeIds(['a', 'a', 'b']), ['a', 'b'])
})

test('normalizes duplicate ids and bounds the request', () => {
  const many = Array.from({ length: 201 }, (_, index) => 'id-' + String(index))
  assert.throws(() => normalizeIds(many), /at most 200/)
})

test('reports locality violations from the Host and Origin headers', () => {
  assert.equal(localityViolation({ headers: { host: '127.0.0.1:3080' } }), null)
  assert.equal(localityViolation({ headers: { host: 'localhost:3080', origin: 'http://localhost:3080' } }), null)
  assert.equal(localityViolation({ headers: { host: '192.168.1.5:3080' } }), 'sessions/not-local')
  assert.equal(localityViolation({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.test' } }), 'sessions/bad-origin')
  assert.equal(localityViolation({ headers: { host: '127.0.0.1:3080', origin: 'not a url' } }), 'sessions/bad-origin')
})

test('projects user, assistant and tool events and skips log-only ones', () => {
  const user = projectEvent({
    type: 'user/message', seq: 1, time: 10,
    data: { message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
  })
  assert.deepEqual(user, { seq: 1, time: 10, role: 'user', text: 'hello', truncated: false })
  const assistant = projectEvent({
    type: 'assistant/message', seq: 2, time: 11,
    data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' }] } },
  })
  assert.equal(assistant.role, 'assistant')
  assert.deepEqual(assistant.toolCalls, [{ name: 'bash', arguments: '{"cmd":"ls"}' }])
  assert.equal(projectEvent({ type: 'step/start', seq: 3, time: 12, data: { turn: 1, step: 1 } }), null)
  assert.equal(projectEvent({ type: 'request/header', seq: 4, time: 13, data: {} }), null)
})

test('truncates an oversized body and marks it', () => {
  const row = projectEvent({
    type: 'user/message', seq: 0, time: 1,
    data: { message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(9000) }] } },
  })
  assert.equal(row.truncated, true)
  assert.match(row.text, /truncated/)
  assert.ok(row.text.length < 9000)
})

test('reads one page and reports whether more events exist', async () => {
  const env = await makeHome()
  const events = Array.from({ length: 5 }, (_, index) => ({
    type: 'user/message', seq: index, time: index,
    data: { message: { role: 'user', content: [{ type: 'text', text: 'm' + String(index) }] } },
  }))
  const { services } = fakeServices({ home: env.home, sessionId: env.sessionId, events })
  const first = await readArchivedSession(services, { id: env.sessionId, limit: 2 })
  assert.deepEqual(first.events.map(event => event.text), ['m0', 'm1'])
  assert.equal(first.hasMore, true)
  assert.equal(first.nextAfter, 2)
  const second = await readArchivedSession(services, { id: env.sessionId, after: first.nextAfter, limit: 2 })
  assert.deepEqual(second.events.map(event => event.text), ['m2', 'm3'])
  const last = await readArchivedSession(services, { id: env.sessionId, after: second.nextAfter, limit: 5 })
  assert.deepEqual(last.events.map(event => event.text), ['m4'])
  assert.equal(last.hasMore, false)
  assert.equal(last.nextAfter, null)
  await rm(env.home, { recursive: true, force: true })
})

test('returns an empty page for a session with no visible events', async () => {
  const env = await makeHome()
  const { services } = fakeServices({ home: env.home, sessionId: env.sessionId, events: [] })
  const result = await readArchivedSession(services, { id: env.sessionId })
  assert.deepEqual(result.events, [])
  assert.equal(result.hasMore, false)
  await rm(env.home, { recursive: true, force: true })
})

test('refuses to read a session that needs migration', async () => {
  const env = await makeHome()
  const { services, calls } = fakeServices({ home: env.home, sessionId: env.sessionId, formatStatus: 'migration-required' })
  await assert.rejects(
    readArchivedSession(services, { id: env.sessionId }),
    error => error.code === 'sessions/migration-required',
  )
  assert.equal(calls.open, 0)
  await rm(env.home, { recursive: true, force: true })
})

test('maps an ownership refusal to a readable code', async () => {
  const env = await makeHome()
  const error = new Error('owned elsewhere')
  error.name = 'SessionAlreadyOwnedError'
  const { services } = fakeServices({ home: env.home, sessionId: env.sessionId, openError: error })
  await assert.rejects(
    readArchivedSession(services, { id: env.sessionId }),
    refusal => refusal.code === 'sessions/owned',
  )
  await rm(env.home, { recursive: true, force: true })
})

test('rejects an unknown session', async () => {
  const env = await makeHome()
  const { services } = fakeServices({ home: env.home, sessionId: env.sessionId })
  await assert.rejects(
    readArchivedSession(services, { id: 'nope' }),
    error => error.code === 'sessions/not-found',
  )
  await rm(env.home, { recursive: true, force: true })
})

test('bounds the accepted request body', () => {
  assert.ok(MAX_BODY_BYTES > 0 && MAX_BODY_BYTES <= 1024 * 1024)
})
