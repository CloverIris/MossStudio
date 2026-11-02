import type { EngineRemoteProgress, RemoteEngineInstallOptions, TrainingHost } from '@shared/types'
import { MOSSINFER_REPO, mossInferArchiveBase } from '../lib/engineAssets'
import { posixQuote, remoteAbsolute, sshExec, sshStream } from './ssh'
import { getSettings } from './settings'
import { resolveGithubToken } from './mossInferDownload'

const REPO = MOSSINFER_REPO
const API = `https://api.github.com/repos/${REPO}`

interface Release {
  tag_name?: string
  assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>
}

interface Artifact {
  id?: number
  name?: string
  expired?: boolean
  size_in_bytes?: number
  archive_download_url?: string
}

interface EngineSource {
  version: string
  url: string
  name: string
  kind: 'release' | 'artifact'
  totalBytes: number
}

function pickAsset(release: Release, options: RemoteEngineInstallOptions): { name: string; url: string; totalBytes: number } {
  const assets = release.assets ?? []
  const name = `${mossInferArchiveBase(String(release.tag_name ?? '').replace(/^v/, ''), 'linux', options.flavour ?? 'cu13', options.variant ?? 'bundled', 'standard')}.tar.gz`
  const candidate = assets.find((asset) => asset.name === name)
  if (!candidate?.browser_download_url || !candidate.name) throw new Error(`上游 Release 没有所选 Linux 引擎包：${name}`)
  return { name: candidate.name, url: candidate.browser_download_url, totalBytes: candidate.size ?? 0 }
}

async function releaseSource(options: RemoteEngineInstallOptions): Promise<EngineSource | null> {
  const suffix = options.releaseTag ? `/releases/tags/${encodeURIComponent(options.releaseTag)}` : '/releases/latest'
  const response = await fetch(`${API}${suffix}`, { headers: { 'user-agent': 'MossStudio' }, signal: AbortSignal.timeout(30_000) })
  if (response.status === 404 && !options.releaseTag) return null
  if (!response.ok) throw new Error(`GitHub Release ${response.status}`)
  const release = (await response.json()) as Release
  const asset = pickAsset(release, options)
  return { version: String(release.tag_name ?? 'artifact').replace(/^v/, ''), url: asset.url, name: asset.name, kind: 'release', totalBytes: asset.totalBytes }
}

async function artifactSource(options: RemoteEngineInstallOptions): Promise<EngineSource> {
  const settings = getSettings()
  const token = resolveGithubToken(settings)
  if (!token) {
    throw new Error('GitHub Actions 构件下载需要 Token，请填写并保存 GitHub Token（或设置 GH_TOKEN）。')
  }
  const runs = await fetch(`${API}/actions/workflows/ci.yml/runs?branch=main&status=success&per_page=1`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'MossStudio' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!runs.ok) throw new Error(`查询 CI runs 失败：HTTP ${runs.status}`)
  const runData = (await runs.json()) as { workflow_runs?: Array<{ id?: number; head_sha?: string }> }
  const run = runData.workflow_runs?.[0]
  if (!run?.id) throw new Error('没有成功的 ci 运行')
  const artifactsResponse = await fetch(`${API}/actions/runs/${run.id}/artifacts`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'MossStudio' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!artifactsResponse.ok) throw new Error(`查询 artifacts 失败：HTTP ${artifactsResponse.status}`)
  const data = (await artifactsResponse.json()) as { artifacts?: Artifact[] }
  const artifactName = `mossinfer-linux-${options.flavour === 'cu12' ? 'cuda12' : 'cuda13'}`
  const artifact = data.artifacts?.find((item) => item.name === artifactName && !item.expired)
  if (!artifact?.archive_download_url) throw new Error('最新 ci 运行没有 Linux 引擎 artifact')
  // Resolve the authenticated API URL to its short-lived signed blob URL locally;
  // only the signed URL is handed to the remote curl command.
  const signed = await fetch(artifact.archive_download_url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'MossStudio' },
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  })
  const location = signed.headers.get('location')
  if (!location) throw new Error(`无法获取 artifact 下载地址（HTTP ${signed.status}）`)
  return { version: `ci-${String(run.head_sha ?? '').slice(0, 8)}`, url: location, name: artifact.name ?? 'artifact', kind: 'artifact', totalBytes: artifact.size_in_bytes ?? 0 }
}

export async function installRemoteEngine(host: TrainingHost, progress?: (phase: EngineRemoteProgress['phase'], message: string, percent?: number, transfer?: Pick<EngineRemoteProgress, 'bytes' | 'totalBytes' | 'speedBps'>) => void, options: RemoteEngineInstallOptions = {}): Promise<{ version: string; path: string; asset: string }> {
  if (options.architecture === 'sm75') throw new Error('上游 SM75 架构包仅支持 Windows，远端 Linux 请使用标准架构或自定义引擎。')
  const root = (await remoteAbsolute(host, host.engineRoot || '~/.mossstudio/engine')).replace(/\/$/, '')
  if (!root) throw new Error('远端引擎目录不能是文件系统根目录')
  progress?.('checking', '检查远端 Linux/curl/tar/flock…', 5)
  const remote = await sshExec(host, 'set -e; uname -s -m; command -v curl >/dev/null 2>&1; command -v tar >/dev/null 2>&1; command -v flock >/dev/null 2>&1; echo READY', 20_000)
  if (!/Linux\s+x86_64/i.test(remote.stdout) || !remote.stdout.includes('READY')) {
    throw new Error('远端引擎安装只支持 Linux x86_64，且需要 curl/tar/flock；CI 构件还需要 unzip')
  }
  progress?.('querying', '查询上游 Release / CI artifact…', 15)
  const source = options.channel === 'dev' ? await artifactSource(options)
    : (await releaseSource(options)) ?? (await artifactSource(options))
  progress?.('downloading', `下载 ${source.name}…`, 25)
  const staging = `${root}.staging`
  const archive = `${staging}.download`
  const identityFile = `${archive}.source`
  const identity = `${source.kind}:${source.version}:${source.name}`
  const proxy = host.downloadProxy?.trim()
  if (proxy && /[\x00-\x1f\x7f]/.test(proxy)) throw new Error('代理地址包含无效控制字符')
  const curlConfig = proxy ? `proxy = "${proxy.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nnoproxy = ""\n` : ''
  const variant = options.variant ?? 'bundled'
  const innerPattern = `mossinfer-*linux-${options.flavour ?? 'cu13'}-x86_64${variant === 'system-cuda' ? '-system-cuda' : ''}.tar.gz`
  const extract = source.kind === 'release'
    ? [`tar -xzf ${posixQuote(archive)} -C ${posixQuote(`${staging}/engine`)}`]
    : [
      `mkdir -p ${posixQuote(`${staging}/outer`)}`,
      `unzip -q ${posixQuote(archive)} -d ${posixQuote(`${staging}/outer`)}`,
      `archive=$(find ${posixQuote(`${staging}/outer`)} -type f -name ${posixQuote(innerPattern)} | head -n1)`,
      `test -n "$archive" || { echo ${posixQuote(`CI 构件没有所选引擎包：${innerPattern}`)} >&2; exit 1; }`,
      `tar -xzf "$archive" -C ${posixQuote(`${staging}/engine`)}`,
    ]
  const script = [
    'set -e',
    `mkdir -p ${posixQuote(root.slice(0, root.lastIndexOf('/')) || '/')}`,
    `exec 9> ${posixQuote(`${archive}.lock`)}`,
    'flock -n 9 || { echo "此目录已有引擎安装正在运行" >&2; exit 1; }',
    // Older installers did not take the lock. Never resume a file they still write.
    'for process in /proc/[0-9]*; do',
    '  IFS= read -r process_name 2>/dev/null < "$process/comm" || continue',
    '  [ "$process_name" = curl ] || continue',
    '  for fd in "$process"/fd/*; do',
    `    if [ "$(readlink "$fd" 2>/dev/null)" = ${posixQuote(archive)} ]; then echo "旧安装任务仍在下载，请等待其结束后重试" >&2; exit 1; fi`,
    '  done',
    'done',
    ...(source.kind === 'artifact' ? ['command -v unzip >/dev/null 2>&1 || { echo "CI 构件需要安装 unzip" >&2; exit 1; }'] : []),
    `rm -rf ${posixQuote(staging)}`,
    `mkdir -p ${posixQuote(staging)}`,
    `if [ "$(cat ${posixQuote(identityFile)} 2>/dev/null)" != ${posixQuote(identity)} ]; then rm -f ${posixQuote(archive)}; fi`,
    `printf '%s' ${posixQuote(identity)} > ${posixQuote(identityFile)}`,
    `curl -q --config - -L --fail --retry 3 --connect-timeout 15 --speed-limit 1024 --speed-time 60 --silent --show-error --continue-at - -o ${posixQuote(archive)} ${posixQuote(source.url)} <&0 &`,
    'download_pid=$!',
    'while kill -0 "$download_pid" 2>/dev/null; do',
    `  printf '__MOSS_ENGINE_BYTES__:%s\\n' "$(stat -c %s ${posixQuote(archive)} 2>/dev/null || echo 0)"`,
    '  sleep 1',
    'done',
    'wait "$download_pid"',
    `printf '__MOSS_ENGINE_BYTES__:%s\\n' "$(stat -c %s ${posixQuote(archive)})"`,
    "printf '__MOSS_ENGINE_PHASE__:extracting\\n'",
    `mkdir -p ${posixQuote(`${staging}/engine`)}`,
    ...extract,
    `top=$(find ${posixQuote(`${staging}/engine`)} -mindepth 1 -maxdepth 1 -type d | head -n1)`,
    `test -n "$top"`,
    `test -x "$top/bin/moss-server"`,
    "printf '__MOSS_ENGINE_PHASE__:installing\\n'",
    `rm -rf ${posixQuote(root)}`,
    `mv "$top" ${posixQuote(root)}`,
    `chmod +x ${posixQuote(`${root}/bin/moss-server`)}`,
    `printf '%s\\n' ${posixQuote(JSON.stringify({ version: source.version, asset: source.name, variant, channel: options.channel ?? 'stable' }))} > ${posixQuote(`${root}/.mossstudio-engine.json`)}`,
    `rm -rf ${posixQuote(staging)} ${posixQuote(archive)} ${posixQuote(identityFile)}`,
  ].join('\n')
  let previousBytes: number | undefined
  let previousTime = Date.now()
  const result = await sshStream(host, script, 30 * 60_000, (line, stream) => {
    if (stream !== 'stdout') return
    if (line === '__MOSS_ENGINE_PHASE__:extracting') progress?.('extracting', '远端解压引擎包…', 70)
    else if (line === '__MOSS_ENGINE_PHASE__:installing') progress?.('installing', '远端安装引擎…', 90)
    else if (line.startsWith('__MOSS_ENGINE_BYTES__:')) {
      const bytes = Number(line.slice('__MOSS_ENGINE_BYTES__:'.length))
      if (!Number.isFinite(bytes) || bytes < 0) return
      const now = Date.now()
      const speedBps = previousBytes === undefined ? 0 : Math.max(0, bytes - previousBytes) * 1000 / Math.max(1, now - previousTime)
      previousBytes = bytes
      previousTime = now
      const percent = source.totalBytes > 0 ? Math.min(69, 25 + bytes / source.totalBytes * 40) : 25
      progress?.('downloading', `下载 ${source.name}…`, percent, { bytes, totalBytes: source.totalBytes, speedBps })
    }
  }, curlConfig)
  if (result.code !== 0) {
    progress?.('error', '远端安装失败', 100)
    throw new Error(`远端引擎安装失败：${(result.stderr || result.stdout).trim().slice(-1800)}`)
  }
  progress?.('done', `引擎 ${source.version} 已安装`, 100)
  return { version: source.version, path: `${root}/bin/moss-server`, asset: source.name }
}
