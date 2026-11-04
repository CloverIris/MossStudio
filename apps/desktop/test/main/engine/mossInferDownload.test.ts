import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Events } from '@shared/channels'
import { decodeEngineHello, type EngineHello } from '@shared/engineProtocol'
import type { GpuInventoryDevice, GpuInventorySnapshot, MossInferDownloadState, Settings } from '@shared/types'
import { useTempDataRoot } from '@test/helpers/tempDir'

const spawnSync = vi.hoisted(() => vi.fn())
const run = vi.hoisted(() => vi.fn())
const probeEngine = vi.hoisted(() => vi.fn<(path: string) => Promise<EngineHello>>())
const getGpuInventory = vi.hoisted(() => vi.fn<() => Promise<GpuInventorySnapshot>>())
const refreshGpuInventory = vi.hoisted(() => vi.fn<() => Promise<GpuInventorySnapshot>>())
const shutdownMossInfer = vi.hoisted(() => vi.fn(async () => undefined))
const resolveServerPath = vi.hoisted(() => vi.fn<(settings: Settings) => string | null>(() => null))
const installCudaWheels = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync, default: { ...actual, spawnSync } }
})
vi.mock('@main/lib/run', () => ({ run }))
vi.mock('@main/lib/probeEngine', () => ({ probeEngine }))
vi.mock('@main/services/devices', () => ({ getGpuInventory, refreshGpuInventory }))
vi.mock('@main/services/mossInfer', () => ({ resolveServerPath, shutdownMossInfer }))
vi.mock('@main/services/cudaWheels', () => ({ installCudaWheels }))
vi.mock('@main/services/network', () => ({ getLastNetwork: () => null, githubMirrorChain: () => [] }))

const dataRoot = useTempDataRoot()
let download: typeof import('@main/services/mossInferDownload')
let settingsModule: typeof import('@main/services/settings')
let emitted: MossInferDownloadState[]
const engineRoot = (): string => join(dataRoot(), 'mossinfer')
const API = 'https://api.github.com/repos/mossimage-cpp/mossimage.cpp'
const archive = Buffer.from('fake engine archive bytes')
const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

const gpu: GpuInventoryDevice = { index: 0, uuid: 'GPU-a', name: 'RTX 4080', computeCapability: { major: 8, minor: 9 }, driverVersion: '581.15' }
const inventory = (devices: GpuInventoryDevice[], error?: string): GpuInventorySnapshot => ({ scannedAt: '', status: 'ok', devices, error })
const hello = (patch: Record<string, unknown> = {}, device: Record<string, unknown> = {}): EngineHello =>
  decodeEngineHello({
    protocol_version: 2, version: '2.1.1',
    probe: { recommended_flavour: 'cu13', devices: [{ index: 0, name: 'RTX 4080', supported: true, compute_capability: '8.9', ...device }] },
    ...patch,
  })

interface Asset { name: string; size: number; browser_download_url: string }
const asset = (name: string, size = archive.length): Asset => ({ name, size, browser_download_url: `https://github.com/dl/${name}` })
let release: { tag_name: string; assets: Asset[] }
let sums = ''
let requests: string[]

function stubGithub(overrides: Record<string, () => Response> = {}): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push(`${init?.method ?? 'GET'} ${url}`)
    if (overrides[url]) return overrides[url]!()
    if (url === `${API}/releases/latest` || url === `${API}/releases/tags/${release.tag_name}`) return Response.json(release)
    if (url.endsWith('/SHA256SUMS')) return new Response(sums)
    if (url.startsWith('https://github.com/dl/')) {
      const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('range') ?? '')
      if (!range) return new Response(archive)
      return new Response(archive.subarray(Number(range[1]), Number(range[2]) + 1), { status: 206 })
    }
    return new Response('not found', { status: 404 })
  }))
}

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('GH_TOKEN', '')
  vi.stubEnv('GITHUB_TOKEN', '')
  spawnSync.mockReset().mockReturnValue({ status: 1, stdout: '' })
  probeEngine.mockReset().mockResolvedValue(hello())
  getGpuInventory.mockReset().mockResolvedValue(inventory([gpu]))
  refreshGpuInventory.mockReset().mockResolvedValue(inventory([gpu]))
  shutdownMossInfer.mockClear()
  resolveServerPath.mockReset().mockReturnValue(null)
  installCudaWheels.mockClear()
  // `tar -xf <archive> -C <dest>` lays out one top-level engine directory.
  run.mockReset().mockImplementation(async (_cmd: string, args: string[]) => {
    const dest = args[args.indexOf('-C') + 1]!
    mkdirSync(join(dest, 'mossinfer-2.1.1', 'bin'), { recursive: true })
    writeFileSync(join(dest, 'mossinfer-2.1.1', 'bin', 'moss-server'), '#!')
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  })
  release = { tag_name: 'v2.1.1', assets: [asset('mossinfer-2.1.1-linux-cu13-x86_64-system-cuda.tar.gz'), asset('SHA256SUMS', 100)] }
  sums = `${sha(archive)}  mossinfer-2.1.1-linux-cu13-x86_64-system-cuda.tar.gz\n`
  requests = []
  stubGithub()
  download = await import('@main/services/mossInferDownload')
  settingsModule = await import('@main/services/settings')
  const { onEmit } = await import('@main/lib/events')
  emitted = []
  onEmit((channel, payload) => { if (channel === Events.mossInferDownload) emitted.push(payload as MossInferDownloadState) })
})

describe('resolveGithubToken', () => {
  it('prefers settings, then GH_TOKEN/GITHUB_TOKEN, then the gh CLI', () => {
    const base = { githubToken: null } as Settings
    expect(download.resolveGithubToken({ githubToken: 'from-settings' } as Settings)).toBe('from-settings')
    vi.stubEnv('GITHUB_TOKEN', ' env-token ')
    expect(download.resolveGithubToken(base)).toBe('env-token')
    vi.stubEnv('GH_TOKEN', 'gh-env')
    expect(download.resolveGithubToken(base)).toBe('gh-env')
    vi.stubEnv('GH_TOKEN', '')
    vi.stubEnv('GITHUB_TOKEN', '')
    spawnSync.mockReturnValue({ status: 0, stdout: 'gho_cli\n' })
    expect(download.resolveGithubToken(base)).toBe('gho_cli')
    expect(spawnSync).toHaveBeenCalledWith('gh', ['auth', 'token'], expect.objectContaining({ timeout: 3000 }))
    spawnSync.mockImplementation(() => { throw new Error('ENOENT') })
    expect(download.resolveGithubToken(base)).toBeNull()
  })
})

describe('listMossInferReleases', () => {
  it('lists published releases only, with asset names and sizes', async () => {
    stubGithub({
      [`${API}/releases?per_page=20`]: () => Response.json([
        { tag_name: 'v3', draft: true, assets: [] },
        { tag_name: 'v2.2-rc', prerelease: true, assets: [] },
        { tag_name: 'v2.1.1', name: '  ', published_at: '2026-01-01', body: 'notes', assets: [{ name: 'a.zip', size: 5, browser_download_url: 'x' }] },
      ]),
    })
    expect(await download.listMossInferReleases()).toEqual([
      { tag: 'v2.1.1', name: 'v2.1.1', publishedAt: '2026-01-01', body: 'notes', assets: [{ name: 'a.zip', size: 5 }] },
    ])
  })

  it('explains GitHub rate limiting and anonymous 403s', async () => {
    stubGithub({ [`${API}/releases?per_page=20`]: () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }) })
    await expect(download.listMossInferReleases()).rejects.toThrow(/请求限流（403）/)
    stubGithub({ [`${API}/releases?per_page=20`]: () => new Response('', { status: 403 }) })
    await expect(download.listMossInferReleases()).rejects.toThrow(/匿名请求限流/)
    stubGithub({ [`${API}/releases?per_page=20`]: () => new Response('', { status: 500 }) })
    await expect(download.listMossInferReleases()).rejects.toThrow('返回 HTTP 500')
  })

  it('wraps network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET') }))
    await expect(download.listMossInferReleases()).rejects.toThrow(/GitHub API 网络请求失败.*ECONNRESET/)
  })
})

describe('downloadMossInfer (stable)', () => {
  it('downloads, verifies, stages, probes, promotes and activates the release', async () => {
    const state = await download.downloadMossInfer('stable', 'cu13', 'system-cuda')
    const installDir = join(engineRoot(), 'stable-v2.1.1-cu13-system-cuda')
    expect(state).toMatchObject({ phase: 'done', percent: 100, variant: 'system-cuda', architecture: 'standard', serverPath: join(installDir, 'bin', 'moss-server') })
    expect(probeEngine).toHaveBeenCalledWith(expect.stringContaining(join(engineRoot(), '.staging')))
    expect(readFileSync(join(installDir, 'bin', 'moss-server'), 'utf8')).toBe('#!')
    expect(settingsModule.getSettings()).toMatchObject({
      mossInferServerPath: join(installDir, 'bin', 'moss-server'), mossInferChannel: 'stable', mossInferVariant: 'system-cuda',
    })
    expect(shutdownMossInfer).toHaveBeenCalled()
    // Work directories are cleaned up; only the install and bookkeeping remain.
    expect(readdirSync(engineRoot()).sort()).toEqual(['.staging', 'last-attempt.json', 'stable-v2.1.1-cu13-system-cuda'])
    expect(readdirSync(join(engineRoot(), '.staging'))).toEqual([])
    expect(JSON.parse(readFileSync(join(engineRoot(), 'last-attempt.json'), 'utf8'))).toMatchObject({ version: 'release v2.1.1' })
    expect(emitted.map((e) => e.phase)).toEqual(expect.arrayContaining(['querying', 'downloading', 'verifying', 'extracting', 'done']))
    expect(download.getMossInferDownloadState()?.phase).toBe('done')
    // The archive was requested as a ranged chunk.
    expect(requests.some((r) => r.startsWith('GET https://github.com/dl/mossinfer-2.1.1-linux-cu13-x86_64-system-cuda.tar.gz'))).toBe(true)
  })

  it('installs CUDA wheels into a system-cuda package when asked', async () => {
    await download.downloadMossInfer('stable', 'cu13', 'system-cuda', true)
    expect(installCudaWheels).toHaveBeenCalledWith(expect.stringContaining('.staging'), 'cu13')
  })

  it('falls back to the bundled package when the release lacks the requested variant', async () => {
    release.assets = [asset('mossinfer-2.1.1-linux-cu13-x86_64.tar.gz')]
    const state = await download.downloadMossInfer('stable', 'cu13', 'system-cuda')
    expect(state).toMatchObject({ phase: 'done', variant: 'bundled' })
    expect(state.note).toContain('已回退到 bundled 包')
    expect(existsSync(join(engineRoot(), 'stable-v2.1.1-cu13'))).toBe(true)
  })

  it('rejects an archive whose SHA256 does not match SHA256SUMS and activates nothing', async () => {
    sums = `${'0'.repeat(64)}  mossinfer-2.1.1-linux-cu13-x86_64-system-cuda.tar.gz\n`
    const state = await download.downloadMossInfer('stable', 'cu13', 'system-cuda')
    expect(state).toMatchObject({ phase: 'error', error: '引擎包 sha256 校验失败（SHA256SUMS 不匹配）' })
    expect(settingsModule.getSettings().mossInferServerPath).toBeNull()
    expect(JSON.parse(readFileSync(join(engineRoot(), 'last-attempt.json'), 'utf8')).error).toContain('sha256')
  })

  it('names the missing asset for a pinned release instead of falling back', async () => {
    release.assets = [asset('mossinfer-2.1.1-windows-cu13-x86_64.zip')]
    const state = await download.downloadMossInfer('stable', 'cu13', 'system-cuda', false, 'v2.1.1')
    expect(state.phase).toBe('error')
    expect(state.error).toContain('release v2.1.1 里没有 mossinfer-2.1.1-linux-cu13-x86_64-system-cuda.tar.gz')
    expect(state.error).toContain('mossinfer-2.1.1-windows-cu13-x86_64.zip')
  })

  it('falls back to the latest CI artifact when the latest release has no matching asset, which needs a token', async () => {
    release.assets = []
    const state = await download.downloadMossInfer('stable', 'cu13', 'system-cuda')
    expect(state.phase).toBe('error')
    expect(state.error).toMatch(/GitHub Actions 构件下载需要 token/)
    expect(emitted.some((e) => e.version === '上游没有 Release，回退到最新 CI artifact')).toBe(true)
  })

  it('does not activate a build with an incompatible protocol and removes its staging dir', async () => {
    probeEngine.mockResolvedValue(hello({ protocol_version: 1 }))
    const state = await download.downloadMossInfer('stable', 'cu13', 'system-cuda')
    expect(state).toMatchObject({ phase: 'error', error: '新引擎协议为 1，需要 protocol 2；未激活该构建' })
    expect(existsSync(join(engineRoot(), '.staging')) ? readdirSync(join(engineRoot(), '.staging')) : []).toEqual([])
    expect(existsSync(join(engineRoot(), 'stable-v2.1.1-cu13-system-cuda'))).toBe(false)
  })

  it('does not activate a build that cannot drive the selected GPU', async () => {
    probeEngine.mockResolvedValue(hello({}, { supported: false, unsupported_reason: 'no sm_89 kernels' }))
    const state = await download.downloadMossInfer('stable', 'cu13', 'system-cuda')
    expect(state.phase).toBe('error')
    expect(state.error).toContain('no sm_89 kernels')
    expect(state.error).toContain('未激活该构建并保留当前引擎')
  })

  it('notes when the engine recommends a different CUDA flavour', async () => {
    probeEngine.mockResolvedValue(hello({ probe: { recommended_flavour: 'cu12', devices: [{ index: 0, name: 'RTX 4080', supported: true }] } }))
    const state = await download.downloadMossInfer('stable', 'cu13', 'system-cuda')
    expect(state).toMatchObject({ phase: 'done', recommendedFlavour: 'cu12' })
    expect(state.note).toContain('引擎建议 CUDA 12')
  })

  it('reports a failed tar extraction', async () => {
    run.mockResolvedValue({ code: 2, stdout: '', stderr: 'gzip: stdin: not in gzip format', timedOut: false })
    const state = await download.downloadMossInfer('stable', 'cu13', 'system-cuda')
    expect(state.error).toBe('引擎包解压失败：gzip: stdin: not in gzip format')
  })

  it('reports an archive without the server binary', async () => {
    run.mockImplementation(async (_cmd: string, args: string[]) => {
      mkdirSync(join(args[args.indexOf('-C') + 1]!, 'top', 'lib'), { recursive: true })
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    })
    const state = await download.downloadMossInfer('stable', 'cu13', 'system-cuda')
    expect(state.error).toMatch(/引擎包里没有/)
  })

  it('reports an archive with more than one top-level entry', async () => {
    run.mockImplementation(async (_cmd: string, args: string[]) => {
      const dest = args[args.indexOf('-C') + 1]!
      mkdirSync(join(dest, 'a'), { recursive: true })
      mkdirSync(join(dest, 'b'), { recursive: true })
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    })
    expect((await download.downloadMossInfer('stable', 'cu13', 'system-cuda')).error).toMatch(/单一顶层目录/)
  })

  it('returns the in-flight state to a second caller', async () => {
    let unblock: () => void = () => undefined
    probeEngine.mockImplementation(() => new Promise((resolve) => { unblock = () => resolve(hello()) }))
    const first = download.downloadMossInfer('stable', 'cu13', 'system-cuda')
    await vi.waitFor(() => expect(probeEngine).toHaveBeenCalled())
    const second = await download.downloadMossInfer('stable', 'cu12', 'bundled')
    expect(second.phase).not.toBe('done')
    unblock()
    expect((await first).phase).toBe('done')
    expect(requests.filter((r) => r.includes('/releases/latest'))).toHaveLength(1)
  })

  it('can be canceled while the release query is in flight', async () => {
    let called = false
    vi.stubGlobal('fetch', vi.fn((_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      called = true
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })))
    const pending = download.downloadMossInfer('stable', 'cu13', 'system-cuda')
    await vi.waitFor(() => expect(called).toBe(true))
    expect(download.cancelMossInferDownload()?.phase).toBe('canceled')
    const state = await pending
    expect(state.phase).toBe('canceled')
    expect(state.error).toBeUndefined()
    expect(existsSync(join(engineRoot(), 'last-attempt.json'))).toBe(false)
    // Canceling again (nothing running) just returns the last state.
    expect(download.cancelMossInferDownload()?.phase).toBe('canceled')
  })
})

describe('downloadMossInfer preflight', () => {
  it.each([
    ['no NVIDIA GPU for automatic architecture', () => getGpuInventory.mockResolvedValue(inventory([])), /没有可用于自动架构判断的 NVIDIA GPU/],
    ['an inventory error', () => getGpuInventory.mockResolvedValue(inventory([], 'nvidia-smi failed')), /^nvidia-smi failed$/],
    ['an unsupported compute capability', () => getGpuInventory.mockResolvedValue(inventory([{ ...gpu, computeCapability: { major: 7, minor: 0 } }])), /SM70，当前上游没有自动匹配/],
    ['an SM75 GPU on Linux', () => getGpuInventory.mockResolvedValue(inventory([{ ...gpu, computeCapability: { major: 7, minor: 5 } }])), /仅提供 Windows CUDA 13 的 SM75/],
    ['a driver older than R580 for CUDA 13', () => getGpuInventory.mockResolvedValue(inventory([{ ...gpu, driverVersion: '560.10' }])), /R580/],
  ])('fails before any download with %s', async (_label, arrange, message) => {
    if (process.platform === 'win32') return
    arrange()
    const state = await download.downloadMossInfer('stable', undefined, 'system-cuda', false, undefined, 'auto')
    expect(state.phase).toBe('error')
    expect(state.error).toMatch(message)
    expect(requests).toEqual([])
    expect(JSON.parse(readFileSync(join(engineRoot(), 'last-attempt.json'), 'utf8')).error).toBe(state.error)
  })

  it('an explicitly selected GPU with an unknown compute capability is not guessed', async () => {
    getGpuInventory.mockResolvedValue(inventory([{ ...gpu, computeCapability: undefined }]))
    settingsModule.updateSettings({ gpuSelection: { uuid: 'GPU-a' } })
    const state = await download.downloadMossInfer('stable', undefined, 'system-cuda', false, undefined, 'auto')
    expect(state.error).toMatch(/RTX 4080 的 SM 计算能力未知/)
    expect(requests).toEqual([])
  })

  it('a selected GPU that disappeared is reported as such', async () => {
    settingsModule.updateSettings({ gpuSelection: { uuid: 'GPU-gone' } })
    const state = await download.downloadMossInfer('stable', undefined, 'system-cuda', false, undefined, 'auto')
    expect(state.error).toMatch(/所选 GPU 当前不可用/)
  })

  it('a manual architecture skips the automatic scan but CUDA 12 skips the R580 rule', async () => {
    getGpuInventory.mockResolvedValue(inventory([{ ...gpu, driverVersion: '560.10' }]))
    release.assets = [asset('mossinfer-2.1.1-linux-cu12-x86_64-system-cuda.tar.gz')]
    sums = ''
    const state = await download.downloadMossInfer('stable', 'cu12', 'system-cuda', false, undefined, 'standard')
    expect(state.phase).toBe('done')
    expect(existsSync(join(engineRoot(), 'stable-v2.1.1-cu12-system-cuda'))).toBe(true)
  })
})
