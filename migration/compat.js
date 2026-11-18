/** DSH storage/runtime facts this migration build was verified against. */
export const SESSION_FORMAT_VERSION = 4
export const WORKSPACE_UNIT_VERSION = 2
export const MINIMUM_NODE_VERSION = '24.9.0'

/** Report whether this Host is inside the verified compatibility envelope. */
export function runtimeCompatibility() {
  const major = Number(process.versions.node.split('.')[0])
  return {
    node: process.versions.node,
    minimumNode: MINIMUM_NODE_VERSION,
    nodeSupported: major >= 24,
    sessionFormatVersion: SESSION_FORMAT_VERSION,
    workspaceUnitVersion: WORKSPACE_UNIT_VERSION,
  }
}
