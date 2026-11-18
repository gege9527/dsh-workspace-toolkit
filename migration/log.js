/**
 * Session log primitives for workspace migration.
 *
 * A DSH session artifact is either a concatenated Zstandard stream whose first
 * frame carries exactly one header JSON line, or a plain JSONL file whose first
 * line is the header. Migration changes ONLY that first line/header frame; the
 * remaining bytes are copied verbatim.
 */
import { open, rename, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'

const ZSTD_MAGIC = 0xFD2FB528
const ZSTD_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const COPY_CHUNK = 1024 * 1024
const MAX_HEADER_LINE = 1024 * 1024

async function readExactly(fd, length, position) {
  const buffer = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const { bytesRead } = await fd.read(buffer, done, length - done, position + done)
    if (bytesRead === 0) throw new Error('unexpected end of session log')
    done += bytesRead
  }
  return buffer
}

/** Locate the first complete Zstandard frame by walking frame/block headers. */
async function firstZstdFrameRange(fd, size) {
  if (size < 5) throw new Error('session log is too short')
  const prefix = await readExactly(fd, Math.min(18, size), 0)
  if (prefix.readUInt32LE(0) !== ZSTD_MAGIC) throw new Error('invalid Zstandard frame magic')
  let offset = 4
  const descriptor = prefix[offset]
  offset += 1
  if ((descriptor & 0x18) !== 0) throw new Error('reserved Zstandard frame-header bit')
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryFlag = descriptor & 0x03
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  if (offset > prefix.length) throw new Error('truncated Zstandard frame header')
  for (;;) {
    if (offset + 3 > size) throw new Error('truncated Zstandard block header')
    const blockHeader = (await readExactly(fd, 3, offset)).readUIntLE(0, 3)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 0x03
    const blockSize = blockHeader >>> 3
    if (blockType === 0x03) throw new Error('reserved Zstandard block type')
    offset += blockType === 0x01 ? 1 : blockSize
    if (offset > size) throw new Error('truncated Zstandard block payload')
    if (lastBlock) break
  }
  if (checksum) offset += 4
  if (offset > size) throw new Error('truncated Zstandard checksum')
  return offset
}

function assertHeaderLine(headerBytes, expectedId) {
  if (headerBytes.length === 0 || headerBytes[headerBytes.length - 1] !== 0x0A) {
    throw new Error('session header line is not newline-terminated')
  }
  const inner = headerBytes.subarray(0, headerBytes.length - 1)
  if (inner.indexOf(0x0A) !== -1) throw new Error('session header frame carries more than one line')
  let parsed
  try {
    parsed = JSON.parse(inner.toString('utf8'))
  } catch (error) {
    throw new Error('session header is not valid JSON: ' + String(error))
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('session header is not a JSON object')
  }
  if (parsed.type !== 'session') throw new Error('first record is not a session header')
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) throw new Error('session header has no id')
  if (expectedId !== undefined && parsed.id !== expectedId) {
    throw new Error('session header id ' + JSON.stringify(parsed.id) + ' does not match ' + JSON.stringify(expectedId))
  }
  if (typeof parsed.cwd !== 'string' || parsed.cwd.length === 0) {
    throw new Error('session header has no cwd')
  }
  return parsed
}

/**
 * Read one session log's header without decoding event frames.
 * @returns {{header: object, headerBytes: Buffer, firstFrameEnd: number, compression: 'zstd'|'none', size: number, mode: number}}
 */
export async function readLogHeader(path, expectedId, forcedCompression) {
  const info = await stat(path)
  const fd = await open(path, 'r')
  try {
    const zstd = forcedCompression !== undefined ? forcedCompression === 'zstd' : path.endsWith('.zstd')
    let headerBytes
    let firstFrameEnd
    if (zstd) {
      firstFrameEnd = await firstZstdFrameRange(fd, info.size)
      const frame = await readExactly(fd, firstFrameEnd, 0)
      let plain
      try {
        plain = zstdDecompressSync(frame)
      } catch (error) {
        throw new Error('cannot decompress session header frame: ' + String(error))
      }
      headerBytes = plain
    } else {
      const limit = Math.min(info.size, MAX_HEADER_LINE)
      const prefix = await readExactly(fd, limit, 0)
      const newline = prefix.indexOf(0x0A)
      if (newline === -1) throw new Error('session log has no header line')
      headerBytes = Buffer.from(prefix.subarray(0, newline + 1))
      firstFrameEnd = newline + 1
    }
    const header = assertHeaderLine(headerBytes, expectedId)
    if (!Number.isSafeInteger(header.version) || header.version < 0) {
      throw new Error('session header has an invalid version')
    }
    return {
      header,
      headerBytes,
      firstFrameEnd,
      compression: zstd ? 'zstd' : 'none',
      size: info.size,
      mode: info.mode & 0o777,
    }
  } finally {
    await fd.close()
  }
}

async function writeAll(fd, buffer) {
  let done = 0
  while (done < buffer.length) {
    const { bytesWritten } = await fd.write(buffer, done, buffer.length - done)
    if (bytesWritten === 0) throw new Error('short write while rewriting session log')
    done += bytesWritten
  }
}

async function fsyncDirectory(directory) {
  let fd
  try {
    fd = await open(directory, 'r')
    await fd.sync()
  } catch {
    // Directory fsync is unavailable on some platforms/filesystems.
  } finally {
    if (fd) await fd.close().catch(() => {})
  }
}

/**
 * Replace the header line/frame atomically and copy every remaining byte
 * unchanged. headerBytes is the complete header line including its newline.
 */
export async function rewriteLogHeader(path, options) {
  const expectedId = options.expectedId
  const source = await readLogHeader(path, expectedId)
  const headerBytes = options.headerBytes
    ? Buffer.from(options.headerBytes)
    : Buffer.from(JSON.stringify({ ...source.header, cwd: options.cwd }) + '\n', 'utf8')
  const expectedCwd = options.expectedCwd !== undefined ? options.expectedCwd : source.header.cwd
  assertHeaderLine(headerBytes, expectedId)

  const first = source.compression === 'zstd'
    ? zstdCompressSync(headerBytes, ZSTD_OPTIONS)
    : headerBytes
  const tempPath = dirname(path) + '/.wstk-' + randomBytes(8).toString('hex') + '.tmp'
  const src = await open(path, 'r')
  let dst
  try {
    dst = await open(tempPath, 'wx', source.mode)
    await writeAll(dst, first)
    let position = source.firstFrameEnd
    while (position < source.size) {
      const length = Math.min(COPY_CHUNK, source.size - position)
      const chunk = Buffer.alloc(length)
      const { bytesRead } = await src.read(chunk, 0, length, position)
      if (bytesRead === 0) throw new Error('unexpected end of source session log')
      await writeAll(dst, chunk.subarray(0, bytesRead))
      position += bytesRead
    }
    await dst.sync()
    await dst.chmod(source.mode)
    await dst.close()
    dst = undefined
    const verify = await readLogHeader(tempPath, expectedId, source.compression)
    if (verify.header.cwd !== expectedCwd) {
      throw new Error('rewritten session header cwd verification failed')
    }
    await rename(tempPath, path)
    await fsyncDirectory(dirname(path))
    return {
      oldHeaderBytes: source.headerBytes,
      oldCwd: source.header.cwd,
      oldSize: source.size,
      newSize: (await stat(path)).size,
      compression: source.compression,
    }
  } catch (error) {
    if (dst) await dst.close().catch(() => {})
    await unlink(tempPath).catch(() => {})
    throw error
  } finally {
    await src.close()
  }
}

/** Read a session log's current header cwd only. */
export async function readLogCwd(path, expectedId) {
  const info = await readLogHeader(path, expectedId)
  return info.header.cwd
}

/** Byte size of an existing file, or undefined when it is absent. */
export async function fileSize(path) {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
}