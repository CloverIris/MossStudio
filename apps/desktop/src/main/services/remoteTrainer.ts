import { createHash } from 'node:crypto'
import type {
  BranchInfo,
  CommitInfo,
  Settings,
  TrainerRuntimeInfo,
  TrainerVersion,
  TrainingHost,
} from '@shared/types'
import { posixQuote, sshExec } from './ssh'
import { getTrainingHost, listTrainingHosts, updateTrainingHostVersions } from './trainingHosts'
import { TRAINER_SOURCE } from './trainerGit'

function rootExpression(root: string): string {
  if (root === '~') return '"$HOME"'
  if (root.startsWith('~/')) return `"$HOME/${root.slice(2).replace(/"/g, '\\"')}"`
  return posixQuote(root)
}

function hostOf(settings: Settings, hostId: string): TrainingHost {
  const host = getTrainingHost(settings, hostId)
  if (!host || host.kind !== 'ssh') throw new Error('SSH 训练主机不存在')
  return host
}

export function remoteSetup(host: TrainingHost): string {
  return [
    `ROOT=${rootExpression(host.trainerRoot)}`,
    'MIRROR="$ROOT/git/kohaku-trainer.git"',
    'VERSIONS="$ROOT/versions"',
    'RUNTIMES="$ROOT/runtimes"',
    'mkdir -p "$ROOT/git" "$VERSIONS" "$RUNTIMES"',
  ].join('\n')
}

async function ensureMirror(settings: Settings, hostId: string): Promise<TrainingHost> {
  const host = hostOf(settings, hostId)
  const command = [
    remoteSetup(host),
    'if [ ! -f "$MIRROR/HEAD" ]; then',
    `  git clone --bare --progress ${posixQuote(TRAINER_SOURCE)} "$MIRROR"`,
    'else',
    '  git -C "$MIRROR" fetch --prune --tags origin "+refs/heads/*:refs/heads/*"',
    'fi',
    'printf "@/mirror@%s\\n" "$MIRROR"',
  ].join('\n')
  const result = await sshExec(host, command, 240_000)
  if (result.code !== 0) throw new Error(`远端训练器仓库失败：${(result.stderr || result.stdout).trim().slice(-1200)}`)
  return host
}

export async function remoteBranches(settings: Settings, hostId: string): Promise<BranchInfo[]> {
  const host = await ensureMirror(settings, hostId)
  const result = await sshExec(
    host,
    [
      remoteSetup(host),
      'git -C "$MIRROR" for-each-ref --format="%(refname:short)|%(objectname)" refs/heads',
      'git -C "$MIRROR" rev-parse --verify "refs/tags/v0.1.0^{commit}" 2>/dev/null || true',
    ].join('\n'),
    30_000,
  )
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim())
  const lines = result.stdout.split('\n')
  const stable = lines.find((line) => /^[0-9a-f]{40}$/.test(line.trim()))?.trim() ?? ''
  return lines
    .filter((line) => line.includes('|'))
    .map((line) => {
      const [name = '', sha = ''] = line.split('|')
      return { name, sha, isDefault: name === 'main', isStable: Boolean(stable) && sha === stable }
    })
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
}

export async function remoteCommits(settings: Settings, hostId: string, branch: string, limit = 80): Promise<CommitInfo[]> {
  const host = await ensureMirror(settings, hostId)
  const safe = branch.replace(/[^A-Za-z0-9._/-]/g, '')
  const result = await sshExec(
    host,
    [
      remoteSetup(host),
      `git -C "$MIRROR" log -n${limit} --format="%H%x1f%h%x1f%ct%x1f%s%x1f%an" ${posixQuote(safe)}`,
    ].join('\n'),
    30_000,
  )
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim())
  return result.stdout
    .split('\n')
    .filter((line) => line.includes('\u001f'))
    .map((line) => {
      const [sha = '', short = '', date = '', subject = '', author = ''] = line.split('\u001f')
      return { sha, short, date: new Date((Number.parseInt(date, 10) || 0) * 1000).toISOString(), subject, author }
    })
}

export async function remoteCreateVersion(
  settings: Settings,
  hostId: string,
  input: { branch: string; commit: string; name?: string },
): Promise<TrainerVersion> {
  const host = await ensureMirror(settings, hostId)
  const short = input.commit.slice(0, 7)
  const id = `remote-${host.id}-${short}`
  const existing = (host.versions ?? []).find((item) => item.id === id)
  if (existing) return existing
  const commits = await remoteCommits(settings, host.id, input.branch, 200)
  const commit = commits.find((item) => item.sha === input.commit)
  const versionPath = `${host.trainerRoot.replace(/\/$/, '')}/versions/${id}`
  const stable = (await remoteBranches(settings, host.id)).some((item) => item.isStable && item.sha === input.commit)
  const metadata: TrainerVersion = {
    id,
    hostId: host.id,
    hostName: host.name,
    name: input.name?.trim() || `Kohaku ${short} · ${host.name}`,
    branch: input.branch,
    commit: input.commit,
    shortCommit: commit?.short ?? short,
    commitDate: commit?.date ?? new Date().toISOString(),
    subject: commit?.subject ?? '',
    author: commit?.author ?? '',
    channel: stable ? 'stable' : 'experimental',
    path: versionPath,
    runtimeId: '',
    runtimeState: 'missing',
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    dirty: false,
    status: 'ok',
  }
  const command = [
    remoteSetup(host),
    'if [ -d "$VERSIONS/' + id + '" ]; then rm -rf "$VERSIONS/' + id + '"; fi',
    `git -C "$MIRROR" worktree add --detach "$VERSIONS/${id}" ${posixQuote(input.commit)}`,
    `printf '%s' ${posixQuote(JSON.stringify(metadata, null, 2))} > "$VERSIONS/${id}/trainer.json"`,
    `printf '%s\\n' ${posixQuote(versionPath)}`,
  ].join('\n')
  const result = await sshExec(host, command, 120_000)
  if (result.code !== 0) throw new Error(`创建远端训练版本失败：${(result.stderr || result.stdout).trim().slice(-1200)}`)
  updateTrainingHostVersions(settings, host.id, [...(host.versions ?? []), metadata])
  return metadata
}

function runtimeIdFor(host: TrainingHost, material: string): string {
  return `tr-${host.id}-${createHash('sha256').update(material).digest('hex').slice(0, 10)}`
}

export async function remoteInstallRuntime(
  settings: Settings,
  version: TrainerVersion,
): Promise<TrainerRuntimeInfo> {
  if (!version.hostId || version.hostId === 'local') throw new Error('该版本不是 SSH 远端版本，拒绝在本机安装远端依赖')
  const host = hostOf(settings, version.hostId)
  const pyproject = await sshExec(host, [remoteSetup(host), `cat "$VERSIONS/${version.id}/pyproject.toml" 2>/dev/null || true`].join('\n'), 20_000)
  const python = await sshExec(host, 'python3 --version 2>&1 || python --version 2>&1', 15_000)
  const uv = await sshExec(host, 'command -v uv 2>/dev/null || true', 10_000)
  const material = JSON.stringify({ pyproject: pyproject.stdout, python: python.stdout.trim(), os: host.remote?.os })
  const id = runtimeIdFor(host, material)
  const runtimePath = `${host.trainerRoot.replace(/\/$/, '')}/runtimes/${id}`
  const runtimeInfo: TrainerRuntimeInfo = {
    id,
    versionId: version.id,
    path: runtimePath,
    python: `${runtimePath}/bin/python`,
    pythonVersion: python.stdout.trim().replace(/^Python\s+/, ''),
    lockHash: createHash('sha256').update(material).digest('hex').slice(0, 12),
    state: 'created',
    deps: [],
    createdAt: new Date().toISOString(),
  }
  const usingUv = Boolean(uv.stdout.trim())
  const create = usingUv
    ? `uv venv "$RUNTIME" --python python3`
    : `python3 -m venv "$RUNTIME"`
  const install = usingUv
    ? `uv pip install --python "$RUNTIME/bin/python" --index-url ${posixQuote(settings.pipIndex ?? 'https://pypi.org/simple')} -e "$VERSIONS/${version.id}"`
    : `"$RUNTIME/bin/python" -m pip install --index-url ${posixQuote(settings.pipIndex ?? 'https://pypi.org/simple')} -e "$VERSIONS/${version.id}"`
  const command = [
    remoteSetup(host),
    `RUNTIME="$RUNTIMES/${id}"`,
    'mkdir -p "$RUNTIME"',
    create,
    install,
  ].join('\n')
  const result = await sshExec(host, command, 3_600_000)
  runtimeInfo.state = result.code === 0 ? 'ready' : 'error'
  const next = (host.versions ?? []).map((item) =>
    item.id === version.id ? { ...item, runtimeId: id, runtimeState: runtimeInfo.state } : item,
  )
  updateTrainingHostVersions(settings, host.id, next)
  if (result.code !== 0) throw new Error(`远端训练环境安装失败：${(result.stderr || result.stdout).trim().slice(-1600)}`)
  return runtimeInfo
}

export async function remoteDoctor(settings: Settings, version: TrainerVersion): Promise<{ ok: boolean; output: string }> {
  const host = hostOf(settings, version.hostId)
  const runtimePath = version.runtimeId ? `${host.trainerRoot.replace(/\/$/, '')}/runtimes/${version.runtimeId}` : ''
  if (!runtimePath) throw new Error('远端训练环境尚未创建')
  const command = [
    remoteSetup(host),
    `RUNTIME=${posixQuote(runtimePath)}`,
    `cd "$VERSIONS/${version.id}"`,
    'if [ -x "$RUNTIME/bin/kohakumoss-doctor" ]; then "$RUNTIME/bin/kohakumoss-doctor"; else "$RUNTIME/bin/python" -m kohakumoss.cli.doctor; fi',
  ].join('\n')
  const result = await sshExec(host, command, 120_000)
  return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim().slice(-12000) }
}

export async function remoteRemoveVersion(settings: Settings, version: TrainerVersion): Promise<void> {
  const host = hostOf(settings, version.hostId)
  const command = [
    remoteSetup(host),
    `git -C "$MIRROR" worktree remove --force "$VERSIONS/${version.id}" 2>/dev/null || true`,
    `rm -rf "$VERSIONS/${version.id}"`,
  ].join('\n')
  await sshExec(host, command, 30_000)
  const remaining = (host.versions ?? []).filter((item) => item.id !== version.id)
  updateTrainingHostVersions(settings, host.id, remaining)
}

export function remoteVersion(settings: Settings, hostId: string, versionId: string): TrainerVersion {
  const version = remoteVersions(settings, hostId).find((item) => item.id === versionId)
  if (!version) throw new Error('远端训练版本不存在')
  return version
}

export function remoteVersions(settings: Settings, hostId: string): TrainerVersion[] {
  const host = getTrainingHost(settings, hostId)
  if (!host) return []
  return (host.versions ?? [])
    .map((version) => ({ ...version, hostId: host.id, hostName: version.hostName || host.name }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function allRemoteVersions(settings: Settings): TrainerVersion[] {
  return listTrainingHosts(settings)
    .filter((host) => host.kind === 'ssh')
    .flatMap((host) => host.versions ?? [])
}

export async function remoteRootCheck(settings: Settings, hostId: string): Promise<{ root: string; ready: boolean; output: string }> {
  const host = hostOf(settings, hostId)
  const result = await sshExec(
    host,
    [remoteSetup(host), 'test -f "$MIRROR/HEAD" && echo mirror-ready || echo mirror-missing; test -d "$ROOT" && echo root-ready'].join('\n'),
    30_000,
  )
  return { root: host.trainerRoot, ready: result.stdout.includes('root-ready'), output: result.stdout.trim() }
}
