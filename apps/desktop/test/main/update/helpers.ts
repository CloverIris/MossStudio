/**
 * Fixtures for the update runtime tests: a store-only zip writer (with unix modes and symlink
 * entries), Ed25519 feed signing, FileLists built from a folder, and a local HTTP file server
 * with Range support and fault injection.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import type { SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, relative, sep } from 'node:path'
import { crc32 } from 'node:zlib'
import type { FileList, PlatformKey, UpdateFeed } from '@shared/install'
import type { UpdatePublicKey } from '@shared/updateKeys'

export interface ZipItem {
  name: string
  data?: string | Buffer
  /** Permission bits (0o755); default 0o644. */
  mode?: number
  /** Makes this a symlink entry pointing at `symlink`. */
  symlink?: string
  dir?: boolean
}

/** A zip (store method) like the pipeline writes: unix "version made by", st_mode in the external attributes. */
export function makeZip(items: readonly ZipItem[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const item of items) {
    const name = Buffer.from(item.dir && !item.name.endsWith('/') ? `${item.name}/` : item.name, 'utf8')
    const data = item.symlink !== undefined ? Buffer.from(item.symlink, 'utf8') : item.dir ? Buffer.alloc(0) : Buffer.from(item.data ?? '')
    const type = item.symlink !== undefined ? 0o120000 : item.dir ? 0o040000 : 0o100000
    const mode = type | (item.mode ?? (item.dir ? 0o755 : item.symlink !== undefined ? 0o777 : 0o644))
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE((mode << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(items.length, 8)
  end.writeUInt16LE(items.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

export interface TestKey {
  id: string
  privateKey: KeyObject
  publicKey: UpdatePublicKey
}

export function makeKey(id = 'test-1'): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  return { id, privateKey, publicKey: { id, publicKey: Buffer.from(raw).toString('base64') } }
}

/** update-<channel>.json.sig bytes for `bytes`. */
export function signFeed(bytes: Buffer, key: TestKey, keyId = key.id): Buffer {
  const signature = sign(null, bytes, key.privateKey).toString('base64')
  return Buffer.from(JSON.stringify({ keyId, signature }))
}

/** A FileList describing `dir` exactly (files with sha256/size/mode, symlinks with targets). */
export function fileListOf(dir: string, version: string, platform: PlatformKey): FileList {
  const entries: FileList['entries'] = []
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder).sort()) {
      const full = join(folder, name)
      const path = relative(dir, full).split(sep).join('/')
      const info = lstatSync(full)
      if (info.isSymbolicLink()) entries.push({ path, type: 'symlink', target: readlinkSync(full) })
      else if (info.isDirectory()) walk(full)
      else entries.push({ path, type: 'file', sha256: sha256(readFileSync(full)), size: info.size, mode: info.mode & 0o777 })
    }
  }
  walk(dir)
  return { schema: 1, version, platform, entries }
}

export function feedFixture(patch: Partial<UpdateFeed> & { version: string }): UpdateFeed {
  return {
    schema: 1,
    channel: 'stable',
    publishedAt: '2026-11-01T00:00:00.000Z',
    notes: `MossStudio ${patch.version}`,
    platforms: {},
    announcements: [],
    ...patch,
  } as UpdateFeed
}

export const thisPlatform = (): PlatformKey =>
  process.platform === 'win32'
    ? 'win32-x64'
    : process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'darwin-arm64'
        : 'darwin-x64'
      : 'linux-x64'

export interface Hit {
  path: string
  headers: IncomingHttpHeaders
}

export interface Route {
  body: Buffer
  /** Ignore Range and always answer 200 with the whole body. */
  noRange?: boolean
  /** Send only this many bytes of the response, then drop the connection. */
  cutAfter?: number
  /** Answer with this status and no body. */
  status?: number
}

export interface FileServer {
  url: (path: string) => string
  routes: Map<string, Route>
  hits: Hit[]
  close: () => Promise<void>
}

/** Serve `routes` on 127.0.0.1 with `Range: bytes=N-` support. Every request is recorded in `hits`. */
export async function startFileServer(routes: Record<string, Route> = {}): Promise<FileServer> {
  const table = new Map(Object.entries(routes))
  const hits: Hit[] = []
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!)
    hits.push({ path, headers: req.headers })
    const route = table.get(path)
    if (!route) {
      res.writeHead(404).end()
      return
    }
    if (route.status) {
      res.writeHead(route.status).end()
      return
    }
    const range = /^bytes=(\d+)-$/.exec(String(req.headers['range'] ?? ''))
    let start = 0
    if (range && !route.noRange) {
      start = Number(range[1])
      if (start >= route.body.length) {
        res.writeHead(416, { 'content-range': `bytes */${route.body.length}` }).end()
        return
      }
      res.writeHead(206, {
        'content-range': `bytes ${start}-${route.body.length - 1}/${route.body.length}`,
        'content-length': String(route.body.length - start),
      })
    } else {
      res.writeHead(200, { 'content-length': String(route.body.length) })
    }
    const slice = route.body.subarray(start)
    if (route.cutAfter !== undefined && route.cutAfter < slice.length) {
      res.write(slice.subarray(0, route.cutAfter), () => setTimeout(() => res.destroy(), 20))
      return
    }
    res.end(slice)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    routes: table,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** A spawn() stand-in: records calls and emits 'spawn' (or `error`) on the next tick, like Node. */
export function fakeSpawn(options: { error?: Error } = {}) {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []
  const children: Array<EventEmitter & { unref: () => void; unrefCalled: boolean }> = []
  const spawn = (command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
    calls.push({ command, args, options: spawnOptions })
    const child = Object.assign(new EventEmitter(), {
      unrefCalled: false,
      unref(this: { unrefCalled: boolean }) {
        this.unrefCalled = true
      },
    })
    children.push(child)
    setImmediate(() => (options.error ? child.emit('error', options.error) : child.emit('spawn')))
    return child
  }
  return { spawn, calls, children }
}
