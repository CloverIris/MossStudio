import type { NetworkProbe, NetworkReport, NetworkSelection, Settings } from '@shared/types'

interface ProbeTarget {
  id: string
  label: string
  url: string
  category: 'git' | 'pip' | 'hf' | 'manifest'
  value: string | null
}

const GITHUB = 'https://github.com'
const RAW_BASE = 'https://raw.githubusercontent.com/CloverIris/MossStudio/main'
const MANIFEST_PATH = '/release/manifest.json'

const TARGETS: ProbeTarget[] = [
  { id: 'github', label: 'GitHub 直连', url: GITHUB, category: 'git', value: null },
  {
    id: 'ghproxy',
    label: 'ghproxy 镜像',
    url: 'https://ghproxy.net/https://github.com',
    category: 'git',
    value: 'https://ghproxy.net/',
  },
  {
    id: 'isteed',
    label: 'cors.isteed 镜像',
    url: 'https://cors.isteed.cc/https://github.com',
    category: 'git',
    value: 'https://cors.isteed.cc/',
  },
  {
    id: 'geekertao',
    label: 'geekertao 镜像',
    url: 'https://ghfile.geekertao.top/https://github.com',
    category: 'git',
    value: 'https://ghfile.geekertao.top/',
  },
  { id: 'pypi', label: 'PyPI 官方', url: 'https://pypi.org/simple/', category: 'pip', value: 'https://pypi.org/simple' },
  {
    id: 'tuna',
    label: '清华 PyPI',
    url: 'https://pypi.tuna.tsinghua.edu.cn/simple/',
    category: 'pip',
    value: 'https://pypi.tuna.tsinghua.edu.cn/simple',
  },
  {
    id: 'aliyun',
    label: '阿里云 PyPI',
    url: 'https://mirrors.aliyun.com/pypi/simple/',
    category: 'pip',
    value: 'https://mirrors.aliyun.com/pypi/simple',
  },
  {
    id: 'hf',
    label: 'HuggingFace',
    url: 'https://huggingface.co/api/models/OpenMOSS-Team/MOSS-Image-Base',
    category: 'hf',
    value: 'https://huggingface.co',
  },
  {
    id: 'hfmirror',
    label: 'hf-mirror',
    url: 'https://hf-mirror.com/api/models/OpenMOSS-Team/MOSS-Image-Base',
    category: 'hf',
    value: 'https://hf-mirror.com',
  },
  {
    id: 'raw',
    label: 'GitHub Raw',
    url: `${RAW_BASE}${MANIFEST_PATH}`,
    category: 'manifest',
    value: RAW_BASE,
  },
  {
    id: 'jsdelivr',
    label: 'jsDelivr',
    url: `https://cdn.jsdelivr.net/gh/CloverIris/MossStudio@main${MANIFEST_PATH}`,
    category: 'manifest',
    value: 'https://cdn.jsdelivr.net/gh/CloverIris/MossStudio@main',
  },
]

const MIRROR_PREFERENCE: Record<ProbeTarget['category'], string[]> = {
  git: ['ghproxy', 'isteed', 'geekertao', 'github'],
  pip: ['tuna', 'aliyun', 'pypi'],
  hf: ['hfmirror', 'hf'],
  manifest: ['jsdelivr', 'raw'],
}

async function probe(target: ProbeTarget, timeoutMs = 3500): Promise<NetworkProbe> {
  const started = Date.now()
  try {
    const response = await fetch(target.url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'MossStudio-Launcher/0.1' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    await response.body?.cancel()
    return {
      id: target.id,
      label: target.label,
      url: target.url,
      ok: response.ok,
      latencyMs: Date.now() - started,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      id: target.id,
      label: target.label,
      url: target.url,
      ok: false,
      latencyMs: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

let lastReport: NetworkReport | null = null

export async function probeNetwork(mode: Settings['networkMode'] = 'auto'): Promise<NetworkReport> {
  const probes = await Promise.all(TARGETS.map((target) => probe(target)))
  const ok = new Map(probes.filter((p) => p.ok).map((p) => [p.id, p]))

  const pick = (category: ProbeTarget['category']): string | null => {
    if (mode === 'direct') {
      const direct = TARGETS.find((t) => t.category === category && t.id === 'github') ??
        TARGETS.find((t) => t.category === category && t.id === 'pypi') ??
        TARGETS.find((t) => t.category === category && t.id === 'hf') ??
        TARGETS.find((t) => t.category === category && t.id === 'raw')
      return direct?.value ?? null
    }
    const order = mode === 'mirror' ? MIRROR_PREFERENCE[category] : [...MIRROR_PREFERENCE[category]]
    for (const id of order) {
      if (!ok.has(id)) continue
      const target = TARGETS.find((t) => t.id === id)
      if (target) return target.value
    }
    return null
  }

  const selected: NetworkSelection = {
    git: pick('git'),
    pip: pick('pip'),
    hf: pick('hf'),
    manifest: pick('manifest'),
  }

  lastReport = { checkedAt: new Date().toISOString(), mode, selected, probes }
  return lastReport
}

export function getLastNetwork(): NetworkReport | null {
  return lastReport
}

/** Mirrors worth trying even when nothing is configured or the probe picked direct. */
export const GITHUB_MIRRORS = [
  'https://ghproxy.net/',
  'https://cors.isteed.cc/',
  'https://ghfile.geekertao.top/',
  'https://gh-proxy.com/',
]

/**
 * Ordered mirror prefixes for a GitHub download. The probe only runs at startup, so a
 * direct-connection result must not disable mirrors forever: built-ins stay in the chain.
 */
export function githubMirrorChain(settings: Settings): string[] {
  if (settings.networkMode === 'direct') return []
  const preferred = settings.gitMirror?.trim() || getLastNetwork()?.selected.git || null
  return [...new Set([preferred, ...GITHUB_MIRRORS].filter((item): item is string => Boolean(item && item.trim())))]
}

export function applyGitMirror(url: string, mirror: string | null): string {
  if (!mirror) return url
  if (mirror.includes('ghproxy') || mirror.includes('gh-proxy')) {
    const prefix = mirror.replace(/https?:\/\/github\.com\/?$/, '')
    return `${prefix.replace(/\/$/, '')}/${url}`
  }
  if (mirror.includes('kkgithub')) return url.replace('https://github.com', mirror.replace(/\/$/, ''))
  return `${mirror.replace(/\/$/, '')}/${url.replace(/^https?:\/\//, '')}`
}
