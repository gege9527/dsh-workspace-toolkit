/**
 * Host half of dsh-workspace-toolkit.
 *
 * Serves the browser half facts it cannot derive by itself:
 *   1. Where the DSH attachment store lives (<DSH_HOME>/attachments/v1).
 *      Uploaded message files are content-addressed objects below that root —
 *      NOT inside the session workspace — so the browser needs the root to
 *      turn a `FileAttachmentRef` into an openable `dsh-resource://file/…`
 *      address.
 *   2. The paste-to-file threshold.  Web deepseek.com converts pasted text
 *      longer than `paste_text_to_file_character_limit` (default 2000 chars)
 *      into a .txt attachment; this plugin mirrors that.
 *
 * The browser half stays a plain lazy-CJS module (no build), so these facts
 * travel over the existing `webserver/index-inject` table instead of an RPC.
 *
 * Zero dependencies, no build step: plain ESM, node: builtins only (no
 * @deepseek-ai/* imports — an npm-published plugin cannot rely on the harness
 * workspace resolver at runtime).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'workspace-toolkit'

/** Default paste-to-file threshold, mirroring web deepseek.com (2000 chars). */
export const DEFAULT_PASTE_TO_FILE_LIMIT = 2000

/** Paste text beyond this byte size cannot be restored into the composer. */
export const MAX_PASTE_RESTORE_BYTES = 614400

/** Resolve DSH home: $DSH_HOME wins, else ~/.dsh. */
export function resolveDshHome(env = process.env) {
  const overridden = env.DSH_HOME
  return (typeof overridden === 'string' && overridden.trim() !== '')
    ? overridden.trim()
    : join(homedir(), '.dsh')
}

export function apply(ctx) {
  const attachmentsRoot = join(resolveDshHome(), 'attachments', 'v1')
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: '__DSH_WORKSPACE_TOOLKIT__',
      value: {
        attachmentsRoot,
        pasteToFileLimit: DEFAULT_PASTE_TO_FILE_LIMIT,
        maxPasteRestoreBytes: MAX_PASTE_RESTORE_BYTES,
      },
    })
  })
}
