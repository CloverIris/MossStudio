import { createHash } from 'node:crypto'
import type { BranchInfo, CommitInfo, RuntimeInfo, Settings, TrainingHost } from '@shared/types'
import { writeRemoteRuntime } from './runtimes'
import { getTrainingHost } from './trainingHosts'
import { DEFAULT_SOURCE } from './git'
import { posixQuote, remoteAbsolute, remotePathExists, sshExec, sshStream } from './ssh'

export interface RemoteInstanceRoots {
  host: TrainingHost
  instanceRoot: string
  modelsRoot: string
}

function hostOf(settings: Settings, hostId: string): TrainingHost {
  const host = getTrainingHost(settings, hostId)
  if (!host || host.kind !== 'ssh') throw new Error('SSH host 不存在')
  return host
}

export async function remoteRoots(settings: Settings, hostId: string): Promise<RemoteInstanceRoots> {
  const host = hostOf(settings, hostId)
  if (!host.instanceRoot) throw new Error('该 host 未配置实例根目录（instanceRoot）')
  const instanceRoot = await remoteAbsolute(host, host.instanceRoot)
  const modelsRoot = await remoteAbsolute(host, host.modelsRoot ?? `${instanceRoot.replace(/\/$/, '')}/models`)
  return { host, instanceRoot, modelsRoot }
}

export function remoteInstancePath(roots: RemoteInstanceRoots, id: string): string {
  return `${roots.instanceRoot.replace(/\/$/, '')}/${id}`
}

export function remoteMirrorPath(roots: RemoteInstanceRoots, source = DEFAULT_SOURCE): string {
  const base = `${roots.instanceRoot.replace(/\/$/, '')}/git`
  if (source === DEFAULT_SOURCE) return `${base}/moss-image.git`
  const key = createHash('sha1').update(source).digest('hex').slice(0, 12)
  return `${base}/moss-image-${key}.git`
}

export async function ensureRemoteMirror(roots: RemoteInstanceRoots, source = DEFAULT_SOURCE): Promise<void> {
  const mirror = remoteMirrorPath(roots, source)
  const gitDir = `${roots.instanceRoot.replace(/\/$/, '')}/git`
  const command = [
    'set -e',
    `mirror=${posixQuote(mirror)}`,
    `mkdir -p ${posixQuote(gitDir)}`,
    'mirror_healthy() {',
    '  [ -f "$mirror/HEAD" ] || return 1',
    `  refs=$(git -C "$mirror" for-each-ref --format='%(refname)' refs/heads 2>/dev/null) || return 1`,
    '  [ -n "$refs" ] || return 1',
    '  for ref in $refs; do',
    '    git -C "$mirror" rev-parse --verify "${ref}^{commit}" >/dev/null 2>&1 && return 0',
    '  done',
    '  return 1',
    '}',
    'archive_broken() {',
    '  archive="$mirror.broken-$(date +%s)-$$"',
    '  mv "$mirror" "$archive"',
    '  printf "保留损坏镜像：%s\\n" "$archive" >&2',
    '}',
    'if [ -e "$mirror" ]; then',
    '  if mirror_healthy; then',
    `    git -C "$mirror" fetch --prune origin '+refs/heads/*:refs/heads/*'`,
    '  elif ! git -C "$mirror" fetch --prune origin \'+refs/heads/*:refs/heads/*\'; then',
    '    echo "无法通过 fetch 修复远端镜像，将保留旧目录并重新克隆" >&2',
    '  fi',
    'fi',
    'if ! mirror_healthy; then',
    '  if [ -e "$mirror" ]; then archive_broken; fi',
    `  git clone --bare --progress ${posixQuote(source)} "$mirror"`,
    '  mirror_healthy || { echo "克隆后的远端镜像仍不可用" >&2; exit 1; }',
    'fi',
  ].join('\n')
  const result = await sshExec(roots.host, command, 300_000)
  if (result.code !== 0) {
    throw new Error(`远端 MOSS 仓库失败：${(result.stderr || result.stdout).trim().slice(-1200)}`)
  }
}

export async function remoteBranches(roots: RemoteInstanceRoots, source = DEFAULT_SOURCE): Promise<BranchInfo[]> {
  const mirror = remoteMirrorPath(roots, source)
  const result = await sshExec(
    roots.host,
    [
      `git -C ${posixQuote(mirror)} for-each-ref --format='%(refname:short)|%(objectname)' refs/heads`,
      `git -C ${posixQuote(mirror)} rev-parse --verify 'refs/heads/main' 2>/dev/null || true`,
    ].join('\n'),
    30_000,
  )
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim())
  const lines = result.stdout.split('\n')
  const main = lines.find((line) => /^[0-9a-f]{40}$/.test(line.trim()))?.trim() ?? ''
  return lines
    .filter((line) => line.includes('|'))
    .map((line) => {
      const [name = '', sha = ''] = line.split('|')
      return {
        name,
        sha,
        isDefault: name === 'main',
        isStable: name === 'main' && !!main && sha === main,
      }
    })
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
}

export async function remoteCommits(
  roots: RemoteInstanceRoots,
  branch: string,
  limit = 80,
  source = DEFAULT_SOURCE,
): Promise<CommitInfo[]> {
  const mirror = remoteMirrorPath(roots, source)
  const safe = branch.replace(/[^A-Za-z0-9._/-]/g, '')
  const result = await sshExec(
    roots.host,
    `git -C ${posixQuote(mirror)} log -n${limit} --format='%H%x1f%h%x1f%ct%x1f%s%x1f%an' ${posixQuote(safe)}`,
    30_000,
  )
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim())
  return result.stdout
    .split('\n')
    .filter((line) => line.includes('\u001f'))
    .map((line) => {
      const [sha = '', short = '', date = '', subject = '', author = ''] = line.split('\u001f')
      return {
        sha,
        short,
        date: new Date((Number.parseInt(date, 10) || 0) * 1000).toISOString(),
        subject,
        author,
      }
    })
}

export async function createRemoteWorktree(
  roots: RemoteInstanceRoots,
  id: string,
  commit: string,
  source = DEFAULT_SOURCE,
): Promise<string> {
  const target = remoteInstancePath(roots, id)
  const mirror = remoteMirrorPath(roots, source)
  const result = await sshExec(
    roots.host,
    [
      `mkdir -p ${posixQuote(roots.instanceRoot)}`,
      `if [ -e ${posixQuote(target)} ]; then echo "TARGET_EXISTS"; exit 4; fi`,
      `git -C ${posixQuote(mirror)} worktree add --detach ${posixQuote(target)} ${posixQuote(commit)}`,
      `printf '%s\\n' ${posixQuote(target)}`,
    ].join('\n'),
    180_000,
  )
  if (result.code !== 0) {
    throw new Error(`创建远端 worktree 失败：${(result.stderr || result.stdout).trim().slice(-1200)}`)
  }
  return target
}

export async function remoteCheckout(roots: RemoteInstanceRoots, id: string, commit: string): Promise<void> {
  const target = remoteInstancePath(roots, id)
  const result = await sshExec(roots.host, `git -C ${posixQuote(target)} checkout --detach ${posixQuote(commit)}`, 60_000)
  if (result.code !== 0) {
    throw new Error(`远端版本切换失败：${(result.stderr || result.stdout).trim().slice(-1200)}`)
  }
}

export async function createRemoteRuntime(roots: RemoteInstanceRoots, instanceId: string, commit: string): Promise<RuntimeInfo> {
  const root = remoteInstancePath(roots, instanceId)
  const venv = `${root}/.venv`
  const command = [
    'set -e',
    `if command -v uv >/dev/null 2>&1; then uv venv ${posixQuote(venv)} --python python3; else python3 -m venv ${posixQuote(venv)}; fi`,
    `${posixQuote(`${venv}/bin/python3`)} --version 2>&1 || ${posixQuote(`${venv}/bin/python`)} --version 2>&1`,
  ].join('\n')
  const result = await sshExec(roots.host, command, 180_000)
  if (result.code !== 0) {
    throw new Error(`创建远端 venv 失败：${(result.stderr || result.stdout).trim().slice(-1200)}`)
  }
  const version = `${result.stdout}${result.stderr}`.match(/Python\s+(\d+\.\d+\.\d+)/)?.[1] ?? 'unknown'
  const runtime: RuntimeInfo = {
    id: `ri-${roots.host.id}-${instanceId}`,
    instanceId,
    instanceIds: [instanceId],
    path: venv,
    python: `${venv}/bin/python3`,
    pythonVersion: version,
    lockHash: createHash('sha256')
      .update(JSON.stringify({ host: roots.host.id, commit, python: version }))
      .digest('hex')
      .slice(0, 12),
    kind: 'isolated',
    state: 'created',
    hostId: roots.host.id,
    remote: true,
    deps: [],
    createdAt: new Date().toISOString(),
  }
  await writeRemoteRuntime(runtime)
  return runtime
}

export async function installRemoteRuntime(
  roots: RemoteInstanceRoots,
  runtime: RuntimeInfo,
  settings: Settings,
  logger?: (line: string, stream?: 'stdout' | 'stderr') => void,
): Promise<RuntimeInfo> {
  const root = `${runtime.path.replace(/\/\.venv$/, '')}`
  const pipIndex = settings.pipIndex ?? 'https://pypi.org/simple'
  const command = [
    'set -e',
    `cd ${posixQuote(root)}`,
    `if command -v uv >/dev/null 2>&1; then`,
    `  uv pip install --python ${posixQuote(runtime.python)} --index-url ${posixQuote(pipIndex)} -r requirements.txt`,
    'else',
    `  ${posixQuote(runtime.python)} -m pip install --index-url ${posixQuote(pipIndex)} -r requirements.txt`,
    'fi',
  ].join('\n')
  runtime.state = 'installing'
  await writeRemoteRuntime(runtime)
  const result = await sshStream(roots.host, command, 3_600_000, (line, stream) => logger?.(line, stream))
  if (result.code !== 0) {
    runtime.state = 'error'
    await writeRemoteRuntime(runtime)
    throw new Error(`远端依赖安装失败：${(result.stderr || result.stdout).trim().slice(-2000)}`)
  }
  runtime.state = 'ready'
  await writeRemoteRuntime(runtime)
  return runtime
}

export async function remoteModelReady(roots: RemoteInstanceRoots, modelRepo = 'models--OpenMOSS-Team--MOSS-Image-SFT'): Promise<boolean> {
  return remotePathExists(roots.host, `${roots.modelsRoot.replace(/\/$/, '')}/hf/hub/${modelRepo}`)
}
