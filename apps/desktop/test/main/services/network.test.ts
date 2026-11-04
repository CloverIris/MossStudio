import { beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsFixture } from '@test/mocks/backend/fixtures'

const source = 'https://github.com/CloverIris/MossStudio.git'
const mirrored = `https://ghproxy.net/${source}`

beforeEach(() => vi.resetModules())
const load = () => import('@main/services/network')

/** fetch stub: URLs containing any of `failing` reject, everything else returns `status`. */
function stubFetch(options: { failing?: string[]; status?: (url: string) => number } = {}) {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (options.failing?.some((part) => url.includes(part))) throw new Error(`blocked ${url}`)
    return new Response(null, { status: options.status?.(url) ?? 200 })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('applyGitMirror', () => {
  it.each([
    'https://ghproxy.net/',
    'https://ghproxy.net',
    'https://ghproxy.net/https://github.com/',
    'https://ghproxy.net/https://github.com',
  ])('ghproxy prefix %s includes the GitHub URL exactly once', async (prefix) => {
    const { applyGitMirror } = await load()
    expect(applyGitMirror(source, prefix)).toBe(mirrored)
  })

  it('treats gh-proxy like ghproxy', async () => {
    const { applyGitMirror } = await load()
    expect(applyGitMirror(source, 'https://gh-proxy.com/https://github.com/')).toBe(`https://gh-proxy.com/${source}`)
  })

  it('keeps direct, kkgithub and host-path mirror formats', async () => {
    const { applyGitMirror } = await load()
    expect(applyGitMirror(source, null)).toBe(source)
    expect(applyGitMirror(source, '')).toBe(source)
    expect(applyGitMirror(source, 'https://kkgithub.com/')).toBe('https://kkgithub.com/CloverIris/MossStudio.git')
    expect(applyGitMirror(source, 'https://mirror.example/')).toBe('https://mirror.example/github.com/CloverIris/MossStudio.git')
  })
})

describe('probeNetwork', () => {
  it('selects a working ghproxy prefix in auto and mirror modes', async () => {
    stubFetch()
    const { probeNetwork, applyGitMirror } = await load()
    for (const mode of ['auto', 'mirror'] as const) {
      const report = await probeNetwork(mode)
      expect(report.selected.git).toBe('https://ghproxy.net/')
      expect(applyGitMirror(source, report.selected.git)).toBe(mirrored)
    }
  })

  it('picks the official endpoints in direct mode regardless of probe results', async () => {
    stubFetch({ failing: ['github.com', 'pypi.org', 'huggingface.co'] })
    const { probeNetwork } = await load()
    const report = await probeNetwork('direct')
    expect(report.selected).toEqual({
      git: null,
      pip: 'https://pypi.org/simple',
      hf: 'https://huggingface.co',
      manifest: 'https://raw.githubusercontent.com/CloverIris/MossStudio/main',
    })
  })

  it('falls through the preference list when mirrors fail or return HTTP errors', async () => {
    stubFetch({ failing: ['ghproxy', 'tuna'], status: (url) => (url.includes('isteed') || url.includes('hf-mirror') ? 503 : 200) })
    const { probeNetwork } = await load()
    const report = await probeNetwork('auto')
    expect(report.selected.git).toBe('https://ghfile.geekertao.top/')
    expect(report.selected.pip).toBe('https://mirrors.aliyun.com/pypi/simple')
    expect(report.selected.hf).toBe('https://huggingface.co')
    expect(report.selected.manifest).toBe('https://cdn.jsdelivr.net/gh/CloverIris/MossStudio@main')
    const isteed = report.probes.find((probe) => probe.id === 'isteed')!
    expect(isteed).toMatchObject({ ok: false, error: 'HTTP 503' })
    expect(isteed.latencyMs).toEqual(expect.any(Number))
    const ghproxy = report.probes.find((probe) => probe.id === 'ghproxy')!
    expect(ghproxy).toMatchObject({ ok: false, latencyMs: null })
    expect(ghproxy.error).toMatch(/blocked/)
  })

  it('selects nothing for a category whose every target is unreachable', async () => {
    stubFetch({ failing: ['pypi', 'aliyun'] })
    const { probeNetwork } = await load()
    expect((await probeNetwork('auto')).selected.pip).toBeNull()
  })

  it('remembers the last report', async () => {
    stubFetch()
    const { probeNetwork, getLastNetwork } = await load()
    expect(getLastNetwork()).toBeNull()
    const report = await probeNetwork('mirror')
    expect(getLastNetwork()).toBe(report)
    expect(report.mode).toBe('mirror')
  })
})

describe('githubMirrorChain', () => {
  it('is empty in direct mode', async () => {
    const { githubMirrorChain } = await load()
    expect(githubMirrorChain(settingsFixture({ networkMode: 'direct', gitMirror: 'https://x/' }))).toEqual([])
  })

  it('puts the configured mirror first and dedupes the built-ins', async () => {
    const { githubMirrorChain, GITHUB_MIRRORS } = await load()
    expect(githubMirrorChain(settingsFixture({ gitMirror: '  https://gh-proxy.com/  ' }))[0]).toBe('https://gh-proxy.com/')
    expect(githubMirrorChain(settingsFixture({ gitMirror: 'https://ghproxy.net/' }))).toEqual(GITHUB_MIRRORS)
    expect(githubMirrorChain(settingsFixture())).toEqual(GITHUB_MIRRORS)
  })

  it('uses the last probed git mirror when none is configured', async () => {
    stubFetch({ failing: ['ghproxy', 'isteed'] })
    const { githubMirrorChain, probeNetwork } = await load()
    await probeNetwork('auto')
    expect(githubMirrorChain(settingsFixture())[0]).toBe('https://ghfile.geekertao.top/')
  })
})
