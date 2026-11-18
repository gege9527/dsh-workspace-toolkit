/**
 * DSH storage path conventions used by workspace migration.
 *
 * These mirror the JSONL session backend and workspace registry exactly; a
 * layout change in DSH must be reflected here together with the compatibility
 * gate in engine.js.
 */
import { homedir } from 'node:os'
import { basename, isAbsolute as pathIsAbsolute, join, posix, relative, win32 } from 'node:path'
import { realpath, stat } from 'node:fs/promises'

/** Resolve DSH home: $DSH_HOME wins, else ~/.dsh. */
export function resolveDshHome(env = process.env) {
  const overridden = env.DSH_HOME
  return (typeof overridden === 'string' && overridden.trim() !== '')
    ? overridden.trim()
    : join(homedir(), '.dsh')
}

/** Root of all session artifacts. */
export function sessionsRoot(dshHome) {
  return join(dshHome, 'sessions')
}

/** Workspace-toolkit private state root. */
export function toolkitRoot(dshHome) {
  return join(dshHome, 'workspace-toolkit')
}

/** Workspace registry document path. */
export function workspaceStorePath(dshHome) {
  return join(dshHome, 'storages', 'workspace.json')
}

/**
 * Build the readable directory key for a project path.
 * Byte-for-byte compatible with the DSH session backend's projectKey().
 * @param {string} cwd
 * @returns {string}
 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * Encode one Session id as a single safe path segment.
 * Byte-for-byte compatible with the DSH session backend's encodeSegment().
 * @param {string} raw
 * @returns {string}
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

/** One session directory below the session root. */
export function sessionDir(root, cwd, id) {
  return join(root, projectKey(cwd), encodeSegment(id))
}

/** Whether a path is fully qualified on this platform. */
export function isFullyQualified(path, platform = process.platform) {
  if (platform !== 'win32') return posix.isAbsolute(path)
  const root = win32.parse(path).root
  return win32.isAbsolute(path) && root !== '\\' && root !== '/'
}

/** Canonicalize an existing directory through realpath. */
export async function canonicalExistingDirectory(path) {
  if (!isFullyQualified(path)) throw new Error(`path is not fully qualified: ${JSON.stringify(path)}`)
  const canonical = await realpath(path)
  const info = await stat(canonical)
  if (!info.isDirectory()) throw new Error(`path is not a directory: ${JSON.stringify(path)}`)
  return canonical
}

/** Whether child is the same as, or below, parent. */
export function isInside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !pathIsAbsolute(rel))
}

/** Default title DSH uses for a workspace path. */
export function defaultWorkspaceTitle(path) {
  return basename(path) || path
}