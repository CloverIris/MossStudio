import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { crc32 } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Events } from '@shared/channels'
import { decodeEngineHello, type EngineHello } from '@shared/engineProtocol'
import type { EnginePackage } from '@shared/enginePackages'
import type { GpuInventoryDevice, GpuInventorySnapshot, MossInferDownloadState, Settings } from '@shared/types'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { setPlatform, usePlatform } from '@test/helpers/platform'

const spawnSync = vi.hoisted(() => vi.fn())
const run = vi.hoisted(() => vi.fn())
const probeEngine = vi.hoisted(() => vi.fn<(path: string) => Promise<EngineHello>>())
const getGpuInventory = vi.hoisted(() => vi.fn<() => Promise<GpuInventorySnapshot>>())
const refreshGpuInventory = vi.hoisted(() => vi.fn<() => Promise<GpuInventorySnapshot>>())
const shutdownMossInfer = vi.hoisted(() => vi.fn(async () => undefined))
const installCudaWheels = vi.hoisted(() => vi.fn(async () => undefined))
const shutdownCliEngines = vi.hoisted(() => vi.fn(async (_filter?: { kind?: string; binary?: string }) => undefined))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync, default: { ...actual, spawnSync } }
})
vi.mock('@main/lib/run', () => ({ run }))
vi.mock('@main/lib/probeEngine', () => ({ probeEngine }))
vi.mock('@main/services/devices', () => ({ getGpuInventory, refreshGpuInventory }))
const releaseStaleMossInferRuntimes = vi.hoisted(() => vi.fn(async () => [] as string[]))
vi.mock('@main/services/mossInfer', () => ({ resolveServerPath: () => null, shutdownMossInfer, releaseStaleMossInferRuntimes }))
vi.mock('@main/services/cudaWheels', () => ({ installCudaWheels }))
vi.mock('@main/services/cliEngine', () => ({ shutdownCliEngines }))
const mirrors = vi.hoisted(() => ({ list: [] as string[] }))
vi.mock('@main/services/network', () => ({ getLastNetwork: () => null, githubMirrorChain: () => mirrors.list }))

// These cases exercise the Linux package flow (tar.gz assets, `tar -xf`, a
// `bin/moss-server` without .exe). The app picks the asset, archive format and
// binary name from process.platform at call time, so pin it on every host.
usePlatform('linux')
const dataRoot = useTempDataRoot()
let download: typeof import('@main/services/mossInferDownload')
let settingsModule: typeof import('@main/services/settings')
let emitted: MossInferDownloadState[]
const engineRoot = (): string => join(dataRoot(), 'mossinfer')
const API = 'https://api.github.com/repos/mossimage-cpp/mossimage.cpp'
const archive = Buffer.from('fake engine archive bytes')
/** Bytes served for every release asset download; tests may swap in a real archive. */
let payload: Buffer = archive
const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

const gpu: GpuInventoryDevice = {
  index: 0,
  uuid: 'GPU-a',
  name: 'RTX 4080',
  computeCapability: { major: 8, minor: 9 },
  driverVersion: '581.15',
}
const inventory = (devices: GpuInventoryDevice[], error?: string): GpuInventorySnapshot => ({ scannedAt: '', status: 'ok', devices, error })
const hello = (patch: Record<string, unknown> = {}, device: Record<string, unknown> = {}): EngineHello =>
  decodeEngineHello({
    protocol_version: 2,
    version: '2.1.1',
    probe: {
      recommended_flavour: 'cu13',
      devices: [{ index: 0, name: 'RTX 4080', supported: true, compute_capability: '8.9', ...device }],
    },
    ...patch,
  })

const CU13_SYSTEM: EnginePackage = { kind: 'cuda', flavour: 'cu13', arch: 'standard', runtime: 'system-cuda' }

interface Asset {
  name: string
  size: number
  browser_download_url: string
}
const asset = (name: string, size = payload.length): Asset => ({ name, size, browser_download_url: `https://github.com/dl/${name}` })
let release: { tag_name: string; assets: Asset[] }
let sums = ''
let requests: string[]

function stubGithub(overrides: Record<string, () => Response> = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push(`${init?.method ?? 'GET'} ${url}`)
      if (overrides[url]) return overrides[url]!()
      // A gh-proxy style mirror: <mirror>/<absolute GitHub URL>. It serves archives but would lie about hashes.
      for (const mirror of mirrors.list) {
        if (!url.startsWith(`${mirror}/`)) continue
        const target = url.slice(mirror.length + 1)
        if (target.endsWith('/SHA256SUMS')) return new Response(`${'f'.repeat(64)}  forged\n`)
        const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('range') ?? '')
        return range ? new Response(payload.subarray(Number(range[1]), Number(range[2]) + 1), { status: 206 }) : new Response(payload)
      }
      if (url === `${API}/releases/latest` || url === `${API}/releases/tags/${release.tag_name}`) return Response.json(release)
      if (url.endsWith('/SHA256SUMS')) return new Response(sums)
      if (url.startsWith('https://github.com/dl/')) {
        const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('range') ?? '')
        if (!range) return new Response(payload)
        return new Response(payload.subarray(Number(range[1]), Number(range[2]) + 1), { status: 206 })
      }
      return new Response('not found', { status: 404 })
    }),
  )
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
  releaseStaleMossInferRuntimes.mockClear()
  installCudaWheels.mockClear()
  shutdownCliEngines.mockReset().mockResolvedValue(undefined)
  // `tar -xf <archive> -C <dest>` lays out one top-level engine directory.
  run.mockReset().mockImplementation(async (_cmd: string, args: string[]) => {
    if (args[0] === '--version') return { code: 0, stdout: 'moss-infer-vulkan 2.2.0\n', stderr: '', timedOut: false }
    const dest = args[args.indexOf('-C') + 1]!
    mkdirSync(join(dest, 'mossinfer-2.1.1', 'bin'), { recursive: true })
    writeFileSync(join(dest, 'mossinfer-2.1.1', 'bin', 'moss-server'), '#!')
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  })
  payload = archive
  release = { tag_name: 'v2.1.1', assets: [asset('mossinfer-2.1.1-linux-cu13-x86_64-system-cuda.tar.gz'), asset('SHA256SUMS', 100)] }
  sums = `${sha(archive)}  mossinfer-2.1.1-linux-cu13-x86_64-system-cuda.tar.gz\n`
  requests = []
  mirrors.list = []
  stubGithub()
  download = await import('@main/services/mossInferDownload')
  settingsModule = await import('@main/services/settings')
  const { onEmit } = await import('@main/lib/events')
  emitted = []
  onEmit((channel, payload) => {
    if (channel === Events.mossInferDownload) emitted.push(payload as MossInferDownloadState)
  })
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
    spawnSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(download.resolveGithubToken(base)).toBeNull()
  })
})

describe('listMossInferReleases', () => {
  it('lists published releases only, with asset names and sizes', async () => {
    stubGithub({
      [`${API}/releases?per_page=20`]: () =>
        Response.json([
          { tag_name: 'v3', draft: true, assets: [] },
          { tag_name: 'v2.2-rc', prerelease: true, assets: [] },
          {
            tag_name: 'v2.1.1',
            name: '  ',
            published_at: '2026-01-01',
            body: 'notes',
            assets: [{ name: 'a.zip', size: 5, browser_download_url: 'x' }],
          },
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET')
      }),
    )
    await expect(download.listMossInferReleases()).rejects.toThrow(/GitHub API 网络请求失败.*ECONNRESET/)
  })
})

describe('downloadMossInfer (stable)', () => {
  it('downloads, verifies, stages, probes, promotes and activates the release', async () => {
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    const installDir = join(engineRoot(), 'stable-v2.1.1-cu13-system-cuda')
    expect(state).toMatchObject({
      phase: 'done',
      percent: 100,
      variant: 'system-cuda',
      architecture: 'standard',
      packages: ['cu13-system-cuda'],
      serverPath: join(installDir, 'bin', 'moss-server'),
    })
    expect(probeEngine).toHaveBeenCalledWith(expect.stringContaining(join(engineRoot(), '.staging')))
    expect(readFileSync(join(installDir, 'bin', 'moss-server'), 'utf8')).toBe('#!')
    // No single pinned moss-server: each GPU runs the newest install of its own package.
    expect(settingsModule.getSettings()).toMatchObject({ mossInferServerPath: null, mossInferChannel: 'stable' })
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
    await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM], cudaWheels: true })
    expect(installCudaWheels).toHaveBeenCalledWith(expect.stringContaining('.staging'), 'cu13')
  })

  it('falls back to the bundled package when the release lacks the requested variant', async () => {
    release.assets = [asset('mossinfer-2.1.1-linux-cu13-x86_64.tar.gz'), asset('SHA256SUMS', 100)]
    sums = `${sha(archive)}  mossinfer-2.1.1-linux-cu13-x86_64.tar.gz\n`
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    expect(state).toMatchObject({ phase: 'done', variant: 'bundled', packages: ['cu13'] })
    expect(state.note).toContain('已回退到 bundled 包')
    expect(existsSync(join(engineRoot(), 'stable-v2.1.1-cu13'))).toBe(true)
  })

  it('after an install, moss-servers that no longer match their GPU are released at once; a failed install releases nothing', async () => {
    await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    expect(releaseStaleMossInferRuntimes).toHaveBeenCalledTimes(1)
    expect(releaseStaleMossInferRuntimes).toHaveBeenCalledWith()
    releaseStaleMossInferRuntimes.mockClear()
    sums = `${'0'.repeat(64)}  mossinfer-2.1.1-linux-cu13-x86_64-system-cuda.tar.gz\n`
    expect((await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })).phase).toBe('error')
    expect(releaseStaleMossInferRuntimes).not.toHaveBeenCalled()
  })

  it('rejects an archive whose SHA256 does not match SHA256SUMS and activates nothing', async () => {
    sums = `${'0'.repeat(64)}  mossinfer-2.1.1-linux-cu13-x86_64-system-cuda.tar.gz\n`
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    expect(state).toMatchObject({ phase: 'error', error: '引擎包 sha256 校验失败（SHA256SUMS 不匹配）' })
    expect(settingsModule.getSettings().mossInferServerPath).toBeNull()
    expect(JSON.parse(readFileSync(join(engineRoot(), 'last-attempt.json'), 'utf8')).error).toContain('sha256')
  })

  it('names the missing asset for a pinned release instead of falling back', async () => {
    release.assets = [asset('mossinfer-2.1.1-windows-cu13-x86_64.zip')]
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM], releaseTag: 'v2.1.1' })
    expect(state.phase).toBe('error')
    expect(state.error).toContain('release v2.1.1 里没有 mossinfer-2.1.1-linux-cu13-x86_64-system-cuda.tar.gz')
    expect(state.error).toContain('mossinfer-2.1.1-windows-cu13-x86_64.zip')
  })

  it('falls back to the latest CI artifact when the latest release has no matching asset, which needs a token', async () => {
    release.assets = []
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    expect(state.phase).toBe('error')
    expect(state.error).toMatch(/GitHub Actions 构件下载需要 token/)
    expect(emitted.some((e) => e.version === '上游没有 Release，回退到最新 CI artifact')).toBe(true)
  })

  it('does not activate a build with an incompatible protocol and removes its staging dir', async () => {
    probeEngine.mockResolvedValue(hello({ protocol_version: 1 }))
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    expect(state).toMatchObject({ phase: 'error', error: '新引擎协议为 1，需要 protocol 2；未激活该构建' })
    expect(existsSync(join(engineRoot(), '.staging')) ? readdirSync(join(engineRoot(), '.staging')) : []).toEqual([])
    expect(existsSync(join(engineRoot(), 'stable-v2.1.1-cu13-system-cuda'))).toBe(false)
  })

  it('does not activate a build that cannot drive the selected GPU', async () => {
    probeEngine.mockResolvedValue(hello({}, { supported: false, unsupported_reason: 'no sm_89 kernels' }))
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    expect(state.phase).toBe('error')
    expect(state.error).toContain('no sm_89 kernels')
    expect(state.error).toContain('未激活该构建并保留当前引擎')
  })

  it('notes when the engine recommends a different CUDA flavour', async () => {
    probeEngine.mockResolvedValue(
      hello({ probe: { recommended_flavour: 'cu12', devices: [{ index: 0, name: 'RTX 4080', supported: true }] } }),
    )
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    expect(state).toMatchObject({ phase: 'done', recommendedFlavour: 'cu12' })
    expect(state.note).toContain('引擎建议 CUDA 12')
  })

  it('reports a failed tar extraction', async () => {
    run.mockResolvedValue({ code: 2, stdout: '', stderr: 'gzip: stdin: not in gzip format', timedOut: false })
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    expect(state.error).toBe('引擎包解压失败：gzip: stdin: not in gzip format')
  })

  it('reports an archive without the server binary', async () => {
    run.mockImplementation(async (_cmd: string, args: string[]) => {
      mkdirSync(join(args[args.indexOf('-C') + 1]!, 'top', 'lib'), { recursive: true })
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    })
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    expect(state.error).toMatch(/引擎包里没有/)
  })

  it('reports an archive with more than one top-level entry', async () => {
    run.mockImplementation(async (_cmd: string, args: string[]) => {
      const dest = args[args.indexOf('-C') + 1]!
      mkdirSync(join(dest, 'a'), { recursive: true })
      mkdirSync(join(dest, 'b'), { recursive: true })
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    })
    expect((await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })).error).toMatch(/单一顶层目录/)
  })

  it('returns the in-flight state to a second caller', async () => {
    let unblock: () => void = () => undefined
    probeEngine.mockImplementation(
      () =>
        new Promise((resolve) => {
          unblock = () => resolve(hello())
        }),
    )
    const first = download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    await vi.waitFor(() => expect(probeEngine).toHaveBeenCalled())
    const second = await download.downloadMossInfer({
      channel: 'stable',
      packages: [{ kind: 'cuda', flavour: 'cu12', arch: 'standard', runtime: 'bundled' }],
    })
    expect(second.phase).not.toBe('done')
    unblock()
    expect((await first).phase).toBe('done')
    expect(requests.filter((r) => r.includes('/releases/latest'))).toHaveLength(1)
  })

  it('can be canceled while the release query is in flight', async () => {
    let called = false
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: string | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            called = true
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      ),
    )
    const pending = download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
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

describe('downloadMossInfer: several packages side by side', () => {
  const vulkanName = 'mossinfer-2.1.1-linux-vulkan-x86_64.tar.gz'
  const hipName = 'mossinfer-2.1.1-linux-hip-x86_64.tar.gz'
  beforeEach(() => {
    release.assets = [
      asset('mossinfer-2.1.1-linux-cu13-x86_64-system-cuda.tar.gz'),
      asset(vulkanName),
      asset(hipName),
      asset('SHA256SUMS', 100),
    ]
    sums = [
      `${sha(archive)}  mossinfer-2.1.1-linux-cu13-x86_64-system-cuda.tar.gz`,
      `${sha(archive)}  ${vulkanName}`,
      `${sha(archive)}  ${hipName}`,
    ].join('\n')
    // Each archive unpacks to its own program: bin/moss-server, bin/moss-infer-vulkan, bin/moss-infer-hip.
    run.mockImplementation(async (cmd: string, args: string[]) => {
      if (args[0] === '--version') {
        return cmd.endsWith('moss-infer-hip')
          ? { code: 127, stdout: '', stderr: 'error while loading shared libraries: libamdhip64.so.7', timedOut: false }
          : { code: 0, stdout: 'moss-infer-vulkan 2.1.1\n', stderr: '', timedOut: false }
      }
      const archivePath = args[args.indexOf('-xf') + 1]!
      const dest = args[args.indexOf('-C') + 1]!
      const program = archivePath.includes('-vulkan')
        ? 'moss-infer-vulkan'
        : archivePath.includes('-hip')
          ? 'moss-infer-hip'
          : 'moss-server'
      mkdirSync(join(dest, 'mossinfer-2.1.1', 'bin'), { recursive: true })
      writeFileSync(join(dest, 'mossinfer-2.1.1', 'bin', program), '#!')
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    })
  })

  it('installs a CUDA and a Vulkan package next to each other in one operation', async () => {
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM, { kind: 'vulkan' }] })
    expect(state).toMatchObject({
      phase: 'done',
      packages: ['cu13-system-cuda', 'vulkan'],
      serverPath: join(engineRoot(), 'stable-v2.1.1-cu13-system-cuda', 'bin', 'moss-server'),
    })
    expect(existsSync(join(engineRoot(), 'stable-v2.1.1-cu13-system-cuda', 'bin', 'moss-server'))).toBe(true)
    expect(existsSync(join(engineRoot(), 'stable-v2.1.1-vulkan', 'bin', 'moss-infer-vulkan'))).toBe(true)
    // The Vulkan CLI is checked with --version, not the moss-server protocol.
    expect(probeEngine).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining('moss-infer-vulkan'),
      ['--version'],
      expect.objectContaining({ timeoutMs: 20_000 }),
    )
    expect(emitted.filter((e) => e.step).map((e) => e.step!.packageId)).toEqual(expect.arrayContaining(['cu13-system-cuda', 'vulkan']))
  })

  it('reinstalling a Vulkan package stops only its own CLI jobs (HIP jobs keep running), never the moss-server', async () => {
    await download.downloadMossInfer({ channel: 'stable', packages: [{ kind: 'vulkan' }] })
    // A HIP install next to it (installed earlier; this box has no ROCm to verify one here).
    mkdirSync(join(engineRoot(), 'stable-v2.1.1-hip', 'bin'), { recursive: true })
    writeFileSync(join(engineRoot(), 'stable-v2.1.1-hip', 'bin', 'moss-infer-hip'), '#!')
    expect(shutdownCliEngines).not.toHaveBeenCalled()
    // Jobs running from both installs; shutdownCliEngines stops those matching its filter
    // (cliEngine.ts contract: same kind, binary inside the given folder).
    const running = [
      { kind: 'vulkan', binary: join(engineRoot(), 'stable-v2.1.1-vulkan', 'bin', 'moss-infer-vulkan') },
      { kind: 'hip', binary: join(engineRoot(), 'stable-v2.1.1-hip', 'bin', 'moss-infer-hip') },
    ]
    shutdownCliEngines.mockImplementation(async (filter?: { kind?: string; binary?: string }) => {
      for (const job of [...running]) {
        const inside = !filter?.binary || job.binary === filter.binary || job.binary.startsWith(`${filter.binary}${sep}`)
        if ((!filter?.kind || job.kind === filter.kind) && inside) running.splice(running.indexOf(job), 1)
      }
    })
    shutdownMossInfer.mockClear()
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [{ kind: 'vulkan' }] })
    expect(state).toMatchObject({ phase: 'done', packages: ['vulkan'] })
    expect(shutdownCliEngines).toHaveBeenCalledTimes(1)
    expect(shutdownCliEngines).toHaveBeenCalledWith({ kind: 'vulkan', binary: join(engineRoot(), 'stable-v2.1.1-vulkan') })
    expect(running.map((job) => job.kind)).toEqual(['hip'])
    expect(shutdownMossInfer).not.toHaveBeenCalled()
  })

  it('reinstalling a CUDA package stops the moss-server, not the CLI jobs', async () => {
    await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    shutdownMossInfer.mockClear()
    await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    expect(shutdownMossInfer).toHaveBeenCalled()
    expect(shutdownCliEngines).not.toHaveBeenCalled()
  })

  it('a package that cannot start is not activated; the ones before it stay', async () => {
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [{ kind: 'vulkan' }, { kind: 'hip' }] })
    expect(state.phase).toBe('error')
    expect(state.error).toContain('libamdhip64.so.7')
    expect(state.error).toContain('未激活该构建')
    expect(state.packages).toEqual(['vulkan'])
    expect(existsSync(join(engineRoot(), 'stable-v2.1.1-vulkan'))).toBe(true)
    expect(existsSync(join(engineRoot(), 'stable-v2.1.1-hip'))).toBe(false)
  })

  it('passes the ROCm library directory to the HIP check', async () => {
    run.mockImplementation(async (cmd: string, args: string[], options?: { env?: Record<string, string> }) => {
      if (args[0] === '--version') {
        return options?.env?.['LD_LIBRARY_PATH'] === '/opt/rocm-7.0.2/lib'
          ? { code: 0, stdout: 'moss-infer-hip 2.1.1 (kernels: gfx1100,gfx1200,gfx1201)\n', stderr: '', timedOut: false }
          : { code: 127, stdout: '', stderr: 'libamdhip64.so.7: cannot open', timedOut: false }
      }
      const dest = args[args.indexOf('-C') + 1]!
      mkdirSync(join(dest, 'mossinfer-2.1.1', 'bin'), { recursive: true })
      writeFileSync(join(dest, 'mossinfer-2.1.1', 'bin', 'moss-infer-hip'), '#!')
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    })
    const state = await download.downloadMossInfer({
      channel: 'stable',
      packages: [{ kind: 'hip' }],
      env: { hip: { LD_LIBRARY_PATH: '/opt/rocm-7.0.2/lib' } },
    })
    expect(state).toMatchObject({ phase: 'done', packages: ['hip'] })
    expect(cmdArgs(run)).toContainEqual(['--version'])
  })

  it('verifies a CUDA package against the GPU it is meant for', async () => {
    const other: GpuInventoryDevice = {
      index: 1,
      uuid: 'GPU-b',
      name: 'Tesla V100',
      computeCapability: { major: 7, minor: 0 },
      driverVersion: '550.1',
    }
    refreshGpuInventory.mockResolvedValue(inventory([gpu, other]))
    probeEngine.mockResolvedValue(
      hello({}, { index: 1, name: 'Tesla V100', supported: false, unsupported_reason: 'compute capability 7.0 is below the required 8.0' }),
    )
    const state = await download.downloadMossInfer({
      channel: 'stable',
      packages: [CU13_SYSTEM],
      targets: { 'cu13-system-cuda': ['GPU-b'] },
    })
    expect(state.phase).toBe('error')
    expect(state.error).toContain('Tesla V100')
  })

  it('refuses a release asset that SHA256SUMS does not list', async () => {
    sums = `${sha(archive)}  ${vulkanName}\n`
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    expect(state).toMatchObject({ phase: 'error' })
    expect(state.error).toContain('SHA256SUMS 里没有 mossinfer-2.1.1-linux-cu13-x86_64-system-cuda.tar.gz')
    expect(requests.some((r) => r.includes('/dl/mossinfer-2.1.1-linux-cu13'))).toBe(false)
  })

  it('refuses a package the release does not publish for this OS', async () => {
    const state = await download.downloadMossInfer({
      channel: 'stable',
      packages: [{ kind: 'cuda', flavour: 'cu13', arch: 'sm75', runtime: 'bundled' }],
    })
    expect(state.error).toContain('上游没有 Linux 版的 CUDA 13 · SM75')
  })
})

function cmdArgs(mock: typeof run): unknown[] {
  return mock.mock.calls.map((call) => call[1])
}

describe('downloadMossInfer: where hashes come from', () => {
  const name = 'mossinfer-2.1.1-linux-cu13-x86_64-system-cuda.tar.gz'

  it('fetches SHA256SUMS from github.com itself even when archives go through a mirror', async () => {
    mirrors.list = ['https://mirror.example']
    settingsModule.updateSettings({ gitMirror: 'https://mirror.example' })
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    expect(state.phase).toBe('done')
    expect(requests.filter((r) => r.includes('SHA256SUMS'))).toEqual(['GET https://github.com/dl/SHA256SUMS'])
    expect(requests.some((r) => r.startsWith(`GET https://mirror.example/https://github.com/dl/${name}`))).toBe(true)
  })

  it("uses GitHub's own asset digest when the API gives one, without SHA256SUMS", async () => {
    release.assets = [{ ...asset(name), digest: `sha256:${sha(archive)}` } as Asset]
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    expect(state.phase).toBe('done')
    expect(requests.some((r) => r.includes('SHA256SUMS'))).toBe(false)
    release.assets = [{ ...asset(name), digest: `sha256:${'0'.repeat(64)}` } as Asset]
    expect((await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })).error).toContain('sha256 校验失败')
  })

  it('a release candidate tag (v2.1.1-rc1) finds its 2.1.1-named assets', async () => {
    release.tag_name = 'v2.1.1-rc1'
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM], releaseTag: 'v2.1.1-rc1' })
    expect(state).toMatchObject({ phase: 'done', packages: ['cu13-system-cuda'] })
    expect(existsSync(join(engineRoot(), 'stable-v2.1.1-rc1-cu13-system-cuda'))).toBe(true)
  })
})

describe('ensureVulkanProbe', () => {
  const name = 'mossinfer-2.1.1-linux-vulkan-x86_64.tar.gz'
  const engineRelease = () => ({
    tag: 'v2.1.1',
    version: '2.1.1',
    sums: `${sha(archive)}  ${name}\n`,
    assets: [{ name, size: archive.length, url: `https://github.com/dl/${name}` }],
  })
  beforeEach(() => {
    run.mockImplementation(async (_cmd: string, args: string[]) => {
      const dest = args[args.indexOf('-C') + 1]!
      mkdirSync(join(dest, 'mossinfer-2.1.1-linux-vulkan-x86_64', 'bin'), { recursive: true })
      writeFileSync(join(dest, 'mossinfer-2.1.1-linux-vulkan-x86_64', 'bin', 'moss-infer-vulkan'), '#!')
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    })
  })

  it('downloads the small Vulkan package once per release, checked against SHA256SUMS', async () => {
    const binary = await download.ensureVulkanProbe(engineRelease())
    expect(binary).toBe(join(engineRoot(), '.probe', 'v2.1.1', 'bin', 'moss-infer-vulkan'))
    expect(existsSync(binary)).toBe(true)
    const downloads = requests.filter((r) => r.includes(`/dl/${name}`)).length
    expect(await download.ensureVulkanProbe(engineRelease())).toBe(binary)
    expect(requests.filter((r) => r.includes(`/dl/${name}`)).length).toBe(downloads)
    expect(readdirSync(join(engineRoot(), '.probe'))).toEqual(['v2.1.1'])
  })

  it('rejects a probe package whose hash does not match', async () => {
    await expect(download.ensureVulkanProbe({ ...engineRelease(), sums: `${'0'.repeat(64)}  ${name}\n` })).rejects.toThrow(
      /sha256 校验失败/,
    )
    expect(existsSync(join(engineRoot(), '.probe', 'v2.1.1'))).toBe(false)
  })

  it('needs the release to list the Vulkan package', async () => {
    await expect(download.ensureVulkanProbe({ ...engineRelease(), assets: [] })).rejects.toThrow(
      /没有 mossinfer-2.1.1-linux-vulkan-x86_64.tar.gz/,
    )
  })
})

/** A minimal stored (uncompressed) ZIP: enough for yauzl, no zip library needed. */
function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const fileName = Buffer.from(name)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(fileName.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(fileName.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, fileName, data)
    centrals.push(central, fileName)
    offset += local.length + fileName.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

describe('downloadMossInfer (stable) on Windows', () => {
  const name = 'mossinfer-2.1.1-windows-cu13-x86_64-system-cuda.zip'
  beforeEach(() => {
    setPlatform('win32')
    release.assets = [asset(name), asset('SHA256SUMS', 100)]
  })

  it('extracts the release .zip itself instead of handing it to tar', async () => {
    payload = storedZip({ 'mossinfer-2.1.1/bin/moss-server.exe': 'MZ', 'mossinfer-2.1.1/bin/cublasLt64_13.dll': 'dll' })
    release.assets = [asset(name), asset('SHA256SUMS', 100)]
    sums = `${sha(payload)}  ${name}\n`
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    const installDir = join(engineRoot(), 'stable-v2.1.1-cu13-system-cuda')
    expect(state).toMatchObject({ phase: 'done', serverPath: join(installDir, 'bin', 'moss-server.exe') })
    expect(run).not.toHaveBeenCalled()
    expect(readFileSync(join(installDir, 'bin', 'moss-server.exe'), 'utf8')).toBe('MZ')
    expect(readFileSync(join(installDir, 'bin', 'cublasLt64_13.dll'), 'utf8')).toBe('dll')
  })

  it('applies the ZIP path-safety checks to release downloads', async () => {
    // yauzl already refuses '..'; an NTFS alternate data stream name is ours to catch.
    payload = storedZip({ 'mossinfer-2.1.1/bin/moss-server.exe': 'MZ', 'mossinfer-2.1.1/bin/moss-server.exe:hidden': 'evil' })
    release.assets = [asset(name), asset('SHA256SUMS', 100)]
    sums = `${sha(payload)}  ${name}\n`
    const state = await download.downloadMossInfer({ channel: 'stable', packages: [CU13_SYSTEM] })
    expect(state).toMatchObject({ phase: 'error', error: 'ZIP 引擎包包含不安全路径：mossinfer-2.1.1/bin/moss-server.exe:hidden' })
    expect(settingsModule.getSettings().mossInferServerPath).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })
})
