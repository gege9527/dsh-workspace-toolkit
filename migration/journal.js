/**
 * Durable migration journal, lock, and crash-injection helpers.
 */
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toolkitRoot } from './paths.js'

export const JOURNAL_SCHEMA_VERSION = 1

export function migrationsRoot(dshHome) {
  return join(toolkitRoot(dshHome), 'migrations')
}

export function journalPath(dshHome, id) {
  return join(migrationsRoot(dshHome), id + '.json')
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** Exit the process exactly at a named step when a test asks for it. */
export function crashPoint(name) {
  if (process.env.WSTK_CRASH_AT === name) {
    process.stderr.write('[workspace-toolkit] injected crash at ' + name + '\n')
    process.exit(97)
  }
}

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
}

/** Acquire the single-migration lock; throws migration/busy when another live process owns it. */
export async function acquireLock(dshHome, migrationId) {
  const root = migrationsRoot(dshHome)
  await ensureDir(root)
  const lockPath = join(root, '.lock')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, migrationId, startedAt: new Date().toISOString() }))
      await handle.close()
      return async function releaseLock() {
        await unlink(lockPath).catch(() => {})
      }
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      let holder = null
      try {
        holder = JSON.parse(await readFile(lockPath, 'utf8'))
      } catch {
        holder = null
      }
      if (holder && isAlive(holder.pid) && holder.pid !== process.pid) {
        const busy = new Error('another workspace migration is running (pid ' + holder.pid + ')')
        busy.code = 'migration/busy'
        throw busy
      }
      await unlink(lockPath).catch(() => {})
    }
  }
  const busy = new Error('cannot acquire workspace migration lock')
  busy.code = 'migration/busy'
  throw busy
}

/** Write one journal atomically. */
export async function writeJournal(dshHome, journal) {
  const root = migrationsRoot(dshHome)
  await ensureDir(root)
  journal.updatedAt = new Date().toISOString()
  const target = journalPath(dshHome, journal.id)
  const temp = target + '.tmp-' + process.pid
  await writeFile(temp, JSON.stringify(journal, null, 2), { mode: 0o600 })
  await rename(temp, target)
  return journal
}

/** Read every pending journal; corrupt files are reported, never ignored. */
export async function listJournals(dshHome) {
  const root = migrationsRoot(dshHome)
  let names = []
  try {
    names = await readdir(root)
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const entries = []
  for (const name of names.sort()) {
    if (name === 'done' || name === '.lock' || !name.endsWith('.json')) continue
    const path = join(root, name)
    try {
      const journal = JSON.parse(await readFile(path, 'utf8'))
      entries.push({ path, journal })
    } catch (error) {
      entries.push({ path, error: String(error && error.message ? error.message : error) })
    }
  }
  return entries
}

/** Move a terminal journal into done/ with a stable name. */
export async function archiveJournal(dshHome, journal) {
  const root = migrationsRoot(dshHome)
  const done = join(root, 'done')
  await ensureDir(done)
  const source = journalPath(dshHome, journal.id)
  const target = join(done, journal.id + '-' + Date.now() + '.json')
  try {
    await rename(source, target)
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
}

/** Delete a rolled-back journal and any leftovers. */
export async function removeJournal(dshHome, journal) {
  await rm(journalPath(dshHome, journal.id), { force: true })
  await rm(journalPath(dshHome, journal.id) + '.tmp-' + process.pid, { force: true }).catch(() => {})
}

/** Copy a diagnostic snapshot of DSH registry state into the journal directory. */
export async function snapshotRegistry(dshHome, journal, extra) {
  const root = migrationsRoot(dshHome)
  await ensureDir(root)
  const dir = join(root, 'snapshots-' + journal.id)
  await ensureDir(dir)
  const workspaceStore = join(dshHome, 'storages', 'workspace.json')
  let copied = false
  try {
    await stat(workspaceStore)
    await writeFile(join(dir, 'workspace.json'), await readFile(workspaceStore), { mode: 0o600 })
    copied = true
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  await writeFile(join(dir, 'headers.json'), JSON.stringify(extra, null, 2), { mode: 0o600 })
  return { dir, copied }
}
