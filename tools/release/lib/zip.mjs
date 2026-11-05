// Minimal zip writer that keeps Unix modes and stores symlinks as symlinks.
//
// Format (read by the app's updater with yauzl, and by unzip/ditto/Explorer):
//   - "version made by" = 3 (Unix) << 8 | 20; external attributes = st_mode << 16
//     (directories also carry the MS-DOS directory bit 0x10)
//   - symlink entries: mode 0o120777, data = link target (UTF-8), always stored
//   - names are UTF-8 (general purpose flag bit 11), '/' separated, directories end in '/'
//   - no zip64: the writer refuses archives that would need it (4 GiB / 65535 entries)
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs'
import { crc32, deflateRawSync } from 'node:zlib'

const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const MAX32 = 0xffffffff
const UTF8_FLAG = 0x0800

/** DOS date/time pair for a Date (local time, 2-second resolution, clamped to 1980). */
export function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

/**
 * Streams entries into a zip file. Each entry is written as soon as it is added, so memory
 * stays at one file at a time.
 *
 *   const zip = new ZipWriter(path, { mtime })
 *   zip.addDirectory('a/')
 *   zip.addFile('a/b.txt', buffer, 0o644)       // or zip.addFileFromDisk(name, srcPath, mode)
 *   zip.addSymlink('a/c', 'b.txt')
 *   zip.close()
 */
export class ZipWriter {
  constructor(path, { mtime = new Date(), level = 6 } = {}) {
    this.fd = openSync(path, 'w')
    this.offset = 0
    this.central = []
    this.names = new Set()
    this.level = level
    this.stamp = dosDateTime(mtime)
  }

  #write(buffer) {
    let written = 0
    while (written < buffer.length) written += writeSync(this.fd, buffer, written, buffer.length - written)
    this.offset += buffer.length
  }

  #entry(name, data, mode, { compress }) {
    if (this.fd === null) throw new Error('zip is closed')
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
      throw new Error(`invalid zip entry name: ${name}`)
    }
    if (this.names.has(name)) throw new Error(`duplicate zip entry: ${name}`)
    this.names.add(name)
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data) >>> 0
    let method = 0
    let payload = data
    if (compress && data.length > 0) {
      const deflated = deflateRawSync(data, { level: this.level })
      if (deflated.length < data.length) {
        method = 8
        payload = deflated
      }
    }
    if (data.length > MAX32 || payload.length > MAX32 || this.offset > MAX32) {
      throw new Error(`zip64 is not supported (entry ${name})`)
    }
    const versionNeeded = method === 8 ? 20 : 10
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(versionNeeded, 4)
    local.writeUInt16LE(UTF8_FLAG, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(this.stamp.time, 10)
    local.writeUInt16LE(this.stamp.day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    const headerOffset = this.offset
    this.#write(local)
    this.#write(nameBytes)
    this.#write(payload)

    const dosDir = (mode & 0o170000) === S_IFDIR ? 0x10 : 0
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE((3 << 8) | 20, 4)
    cd.writeUInt16LE(versionNeeded, 6)
    cd.writeUInt16LE(UTF8_FLAG, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(this.stamp.time, 12)
    cd.writeUInt16LE(this.stamp.day, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(payload.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBytes.length, 28)
    cd.writeUInt16LE(0, 30) // extra
    cd.writeUInt16LE(0, 32) // comment
    cd.writeUInt16LE(0, 34) // disk
    cd.writeUInt16LE(0, 36) // internal attributes
    cd.writeUInt32LE((((mode & 0xffff) << 16) | dosDir) >>> 0, 38)
    cd.writeUInt32LE(headerOffset, 42)
    this.central.push(Buffer.concat([cd, nameBytes]))
  }

  addDirectory(name, mode = 0o755) {
    this.#entry(name.endsWith('/') ? name : `${name}/`, Buffer.alloc(0), S_IFDIR | (mode & 0o7777), { compress: false })
  }

  addFile(name, data, mode = 0o644) {
    this.#entry(name, data, S_IFREG | (mode & 0o7777), { compress: true })
  }

  addFileFromDisk(name, source, mode = 0o644) {
    this.addFile(name, readFileSync(source), mode)
  }

  addSymlink(name, target) {
    this.#entry(name, Buffer.from(target, 'utf8'), S_IFLNK | 0o777, { compress: false })
  }

  close() {
    if (this.fd === null) return
    if (this.central.length > 0xffff) throw new Error('zip64 is not supported (too many entries)')
    const cdOffset = this.offset
    for (const record of this.central) this.#write(record)
    const cdSize = this.offset - cdOffset
    if (cdOffset > MAX32 || this.offset > MAX32) throw new Error('zip64 is not supported (archive too large)')
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(0, 4)
    end.writeUInt16LE(0, 6)
    end.writeUInt16LE(this.central.length, 8)
    end.writeUInt16LE(this.central.length, 10)
    end.writeUInt32LE(cdSize, 12)
    end.writeUInt32LE(cdOffset, 16)
    end.writeUInt16LE(0, 20)
    this.#write(end)
    closeSync(this.fd)
    this.fd = null
  }

  /** Close and delete nothing: callers remove a half-written file themselves. */
  abort() {
    if (this.fd !== null) closeSync(this.fd)
    this.fd = null
  }
}

/** Kind of a zip entry from its external attributes (as yauzl exposes them). */
export function entryKind(externalFileAttributes, fileName) {
  const mode = (externalFileAttributes >>> 16) & 0xffff
  const type = mode & 0o170000
  if (type === S_IFLNK) return { kind: 'symlink', mode: mode & 0o7777 }
  if (type === S_IFDIR || fileName.endsWith('/')) return { kind: 'directory', mode: mode & 0o7777 }
  return { kind: 'file', mode: type === S_IFREG ? mode & 0o7777 : 0o644 }
}
