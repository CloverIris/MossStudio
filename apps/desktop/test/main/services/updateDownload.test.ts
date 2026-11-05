import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseInstaller, UpdateDownloadState } from '@shared/release'
import type { Settings } from '@shared/types'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'

/** Minimal stored ZIP writer; `mode` sets the unix file type bits (e.g. 0o120777 for a symlink). */
function zip(entries: Array<{ name: string; data?: string; mode?: number }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '')
    const name = Buffer.from(entry.name)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42)
    locals.push(local, name, data)
    centrals.push(central, name)
    offset += 30 + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const state = { settings: settingsFixture({ networkMode: 'direct' }) as Settings, events: [] as UpdateDownloadState[] }
vi.mock('@main/services/settings', () => ({ getSettings: () => state.settings }))
vi.mock('@main/lib/events', () => ({ emit: (_channel: string, payload: UpdateDownloadState) => state.events.push(payload) }))

const root = useTempDataRoot()
const originalPlatform = process.platform
const setPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true })
const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex')
const payload = Buffer.from('installer bytes '.repeat(64))

function installer(patch: Partial<ReleaseInstaller> = {}, body = payload): ReleaseInstaller {
  return {
    platform: process.platform as ReleaseInstaller['platform'], arch: process.arch as ReleaseInstaller['arch'], kind: 'appimage',
    url: 'https://downloads.example.test/MossStudio-1.2.0.AppImage', sha256: sha(body), size_bytes: body.length, ...patch,
  }
}

function serve(routes: Record<string, Buffer | number | Error>) {
  const fetch = vi.fn(async (input: string | URL) => {
    const route = routes[String(input)]
    if (route instanceof Error) throw route
    if (typeof route === 'number') return new Response('', { status: route })
    if (!route) return new Response('', { status: 404 })
    return new Response(new Uint8Array(route))
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('CLOVER_UPDATE_TEST', '1')
  state.settings = settingsFixture({ networkMode: 'direct' })
  state.events = []
})
afterEach(() => setPlatform(originalPlatform))
const load = () => import('@main/services/updateDownload')

describe('validation', () => {
  it.each([
    ['not semver', '1.2', {}, '有效的 SemVer'],
    ['http url', '1.2.0', { url: 'http://downloads.example.test/x' }, '必须使用 HTTPS'],
    ['bad sha', '1.2.0', { sha256: 'abc' }, '有效的 sha256'],
    ['zero size', '1.2.0', { size_bytes: 0 }, '大小无效'],
    ['other platform', '1.2.0', { platform: process.platform === 'darwin' ? 'linux' : 'darwin' }, '平台与当前设备不匹配'],
    ['other arch', '1.2.0', { arch: process.arch === 'arm64' ? 'x64' : 'arm64' }, '架构与当前设备不匹配'],
  ] as const)('rejects %s before downloading', async (_label, version, patch, message) => {
    const fetch = serve({})
    await expect((await load()).downloadUpdate(version, installer(patch as Partial<ReleaseInstaller>))).rejects.toThrow(message)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('allows loopback http only in update-test mode', async () => {
    serve({ 'http://127.0.0.1:9/x.AppImage': payload })
    const result = await (await load()).downloadUpdate('1.2.0-beta.1+build.5', installer({ url: 'http://127.0.0.1:9/x.AppImage' }))
    expect(result.phase).toBe('ready')
    vi.resetModules()
    vi.stubEnv('CLOVER_UPDATE_TEST', '0')
    await expect((await load()).downloadUpdate('1.2.0', installer({ url: 'http://127.0.0.1:9/x.AppImage' }))).rejects.toThrow('HTTPS')
  })
})

describe('downloadUpdate', () => {
  it('downloads, verifies and stores the installer under downloads/updates/<version>', async () => {
    const target = installer()
    serve({ [target.url]: payload })
    const { downloadUpdate, getUpdateDownloadState } = await load()
    const result = await downloadUpdate('1.2.0', target)
    expect(result).toMatchObject({ phase: 'ready', bytes: payload.length, percent: 100, version: '1.2.0' })
    expect(result.path).toBe(join(root(), 'downloads', 'updates', '1.2.0', 'MossStudio-1.2.0.AppImage'))
    expect(readFileSync(result.path!)).toEqual(payload)
    expect(existsSync(`${result.path}.part`)).toBe(false)
    expect(state.events.map((event) => event.phase)).toEqual(expect.arrayContaining(['downloading', 'verifying', 'ready']))
    expect(getUpdateDownloadState('1.2.0')).toEqual(result)
  })

  it('fails on a checksum or size mismatch and leaves no partial file', async () => {
    const { downloadUpdate } = await load()
    const tampered = Buffer.from(payload).fill(0x41, 0, 4)
    serve({ [installer().url]: tampered })
    const bad = await downloadUpdate('1.2.0', installer())
    expect(bad.phase).toBe('error')
    expect(bad.error).toMatch(/sha256 校验失败/)
    serve({ [installer().url]: payload.subarray(10) })
    const short = await downloadUpdate('1.2.1', installer())
    expect(short.error).toMatch(/下载大小不匹配/)
    for (const version of ['1.2.0', '1.2.1']) {
      expect(readdirSync(join(root(), 'downloads', 'updates', version))).toEqual([])
    }
  })

  it('tries GitHub mirrors after the direct URL and lists every failure', async () => {
    state.settings = settingsFixture({ networkMode: 'auto' })
    const url = 'https://github.com/CloverIris/MossStudio/releases/download/v1.2.0/MossStudio.AppImage'
    const fetch = serve({ [url]: 502, [`https://ghproxy.net/${url}`]: new Error('reset'), [`https://cors.isteed.cc/${url}`]: payload })
    const result = await (await load()).downloadUpdate('1.2.0', installer({ url }))
    expect(result.phase).toBe('ready')
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([url, `https://ghproxy.net/${url}`, `https://cors.isteed.cc/${url}`])
    vi.resetModules()
    serve({})
    const failed = await (await load()).downloadUpdate('1.2.0', installer({ url }))
    expect(failed.error).toMatch(/^所有下载源均失败：github\.com: HTTP 404；ghproxy\.net: HTTP 404/)
  })

  it('prefers a configured mirror before the direct URL', async () => {
    state.settings = settingsFixture({ networkMode: 'auto', gitMirror: 'https://gh-proxy.com/' })
    const url = 'https://github.com/CloverIris/MossStudio/releases/download/v1.2.0/MossStudio.AppImage'
    const fetch = serve({ [`https://gh-proxy.com/${url}`]: payload })
    await (await load()).downloadUpdate('1.2.0', installer({ url }))
    expect(String(fetch.mock.calls[0]![0])).toBe(`https://gh-proxy.com/${url}`)
  })

  it('never uses mirrors for non-GitHub hosts', async () => {
    state.settings = settingsFixture({ networkMode: 'auto' })
    const fetch = serve({})
    await (await load()).downloadUpdate('1.2.0', installer())
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('cancels an in-flight download', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init: { signal: AbortSignal }) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(payload.subarray(0, 10))
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')))
      },
    }))))
    const { downloadUpdate, cancelUpdateDownload } = await load()
    const pending = downloadUpdate('1.2.0', installer())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(cancelUpdateDownload('1.2.0')?.phase).toBe('downloading')
    const result = await pending
    expect(result).toMatchObject({ phase: 'canceled', error: '下载或解压已取消' })
    expect(cancelUpdateDownload('unknown')).toBeNull()
  })
})

describe('Windows ZIP updates', () => {
  const zipInstaller = (body: Buffer): ReleaseInstaller => ({
    platform: 'win32', arch: process.arch as ReleaseInstaller['arch'], kind: 'zip',
    url: 'https://downloads.example.test/MossStudio-1.2.0-win32.zip', sha256: sha(body), size_bytes: body.length,
  })

  async function install(entries: Parameters<typeof zip>[0]) {
    setPlatform('win32')
    const body = zip(entries)
    serve({ [zipInstaller(body).url]: body })
    return (await load()).downloadUpdate('1.2.0', zipInstaller(body))
  }

  it('extracts a complete package into a stage directory', async () => {
    const result = await install([
      { name: 'MossStudio.exe', data: 'exe' }, { name: 'resources/', mode: 0o40755 },
      { name: 'resources/app.asar', data: 'asar' }, { name: 'resources/release/updater.ps1', data: 'ps1' },
    ])
    expect(result.phase).toBe('ready')
    expect(result.path!.endsWith('.zip.stage')).toBe(true)
    expect(readFileSync(join(result.path!, 'resources', 'app.asar'), 'utf8')).toBe('asar')
  })

  it('rejects a package without the executable, app or updater', async () => {
    const result = await install([{ name: 'MossStudio.exe', data: 'exe' }])
    expect(result).toMatchObject({ phase: 'error', error: expect.stringContaining('缺少 MossStudio 可执行文件') })
  })

  it.each([
    ['parent traversal', '../evil.txt'],
    ['nested traversal', 'resources/../../evil.txt'],
    ['absolute path', '/evil.txt'],
    ['drive letter', 'C:/evil.txt'],
    ['dot segment', './a.txt'],
  ])('refuses %s entries', async (_label, name) => {
    const result = await install([{ name, data: 'x' }])
    expect(result.phase).toBe('error')
    // Either yauzl's own filename validation or the extractor's check rejects it.
    expect(result.error).toMatch(/不安全路径|路径越界|invalid relative path|absolute path/)
    expect(existsSync(join(dirname(join(root(), 'downloads')), 'evil.txt'))).toBe(false)
  })

  it('refuses symlink entries', async () => {
    const result = await install([{ name: 'link', data: '/etc/passwd', mode: 0o120777 }])
    expect(result.error).toMatch(/不安全路径/)
  })
})
