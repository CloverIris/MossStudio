// Read-only views into packaged artifacts, for verify-artifacts and the tests:
//   - the app version baked into resources/app.asar (asar header + package.json)
//   - the setup file's payload (launcher/internal/payload: stub + gzip(tar) + 64-byte trailer)
import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, fstatSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const n = readSync(fd, buffer, done, length - done, position + done)
    if (n === 0) throw new Error('unexpected end of file')
    done += n
  }
  return buffer
}

/** package.json of an app.asar (asar format: pickled header size, JSON header, file data). */
export function asarPackageJson(asarPath) {
  const fd = openSync(asarPath, 'r')
  try {
    const head = readAt(fd, 0, 16)
    const headerSize = head.readUInt32LE(4)
    const jsonLength = head.readUInt32LE(12)
    const header = JSON.parse(readAt(fd, 16, jsonLength).toString('utf8'))
    const entry = header.files?.['package.json']
    if (!entry || entry.unpacked) throw new Error(`${asarPath} has no packed package.json`)
    return JSON.parse(readAt(fd, 8 + headerSize + Number(entry.offset), entry.size).toString('utf8'))
  } finally {
    closeSync(fd)
  }
}

export const TRAILER_SIZE = 64
const MAGIC = 'MossPay1'

/** Parse and hash-check a setup file's trailer; returns the payload's gzip bytes. */
export function readSetupPayload(path) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size < TRAILER_SIZE) throw new Error(`${path}: too small to be a setup file`)
    const trailer = readAt(fd, size - TRAILER_SIZE, TRAILER_SIZE)
    if (trailer.subarray(56).toString('latin1') !== MAGIC) throw new Error(`${path}: no payload trailer`)
    const offset = Number(trailer.readBigUInt64LE(0))
    const length = Number(trailer.readBigUInt64LE(8))
    const version = trailer.readUInt32LE(48)
    if (version !== 1) throw new Error(`${path}: payload format ${version}`)
    if (offset + length + TRAILER_SIZE !== size) throw new Error(`${path}: trailer does not match the file size`)
    const payload = readAt(fd, offset, length)
    if (!createHash('sha256').update(payload).digest().equals(trailer.subarray(16, 48))) throw new Error(`${path}: payload checksum mismatch`)
    return { stub: readAt(fd, 0, Math.min(offset, 4)), payload }
  } finally {
    closeSync(fd)
  }
}

function tarString(block, start, length) {
  const raw = block.subarray(start, start + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8')
}

function tarNumber(block, start, length) {
  const text = tarString(block, start, length).trim()
  return text ? parseInt(text, 8) : 0
}

function paxRecords(data) {
  const out = {}
  let i = 0
  while (i < data.length) {
    const space = data.indexOf(0x20, i)
    if (space === -1) break
    const length = Number(data.subarray(i, space).toString('ascii'))
    if (!length) break
    const record = data.subarray(space + 1, i + length - 1).toString('utf8')
    const eq = record.indexOf('=')
    out[record.slice(0, eq)] = record.slice(eq + 1)
    i += length
  }
  return out
}

/** Entries of an uncompressed POSIX/PAX tar: { name, type: 'file'|'dir'|'symlink', mode, data, target }. */
export function readTar(buffer) {
  const entries = []
  let offset = 0
  let pax = {}
  while (offset + 512 <= buffer.length) {
    const block = buffer.subarray(offset, offset + 512)
    if (block.every((byte) => byte === 0)) break
    const size = tarNumber(block, 124, 12)
    const flag = String.fromCharCode(block[156] || 0x30)
    const prefix = tarString(block, 345, 155)
    let name = tarString(block, 0, 100)
    if (prefix) name = `${prefix}/${name}`
    const data = buffer.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (flag === 'x') { pax = paxRecords(data); continue }
    // GNU tar's own long-name records (its default format), as PAX would carry them.
    if (flag === 'L') { pax.path = tarString(data, 0, data.length); continue }
    if (flag === 'K') { pax.linkpath = tarString(data, 0, data.length); continue }
    if (flag === 'g') continue
    name = pax.path ?? name
    const target = pax.linkpath ?? tarString(block, 157, 100)
    pax = {}
    const mode = tarNumber(block, 100, 8) & 0o7777
    const type = flag === '5' ? 'dir' : flag === '2' ? 'symlink' : flag === '0' ? 'file' : `other:${flag}`
    entries.push({ name: name.replace(/\/$/, ''), type, mode, data: type === 'file' ? data : undefined, target: type === 'symlink' ? target : undefined })
  }
  return entries
}

export function readSetupTar(path) {
  const { stub, payload } = readSetupPayload(path)
  return { stub, entries: readTar(gunzipSync(payload)) }
}

/** package.json of an app.asar held in memory (e.g. read from a zip entry). */
export function asarPackageJsonFromBuffer(buffer) {
  const headerSize = buffer.readUInt32LE(4)
  const jsonLength = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.subarray(16, 16 + jsonLength).toString('utf8'))
  const entry = header.files?.['package.json']
  if (!entry || entry.unpacked) throw new Error('app.asar has no packed package.json')
  const start = 8 + headerSize + Number(entry.offset)
  return JSON.parse(buffer.subarray(start, start + entry.size).toString('utf8'))
}
