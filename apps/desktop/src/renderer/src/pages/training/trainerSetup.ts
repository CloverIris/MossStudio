import { Ipc } from '@shared/channels'
import type { BranchInfo, CommitInfo, TrainerRuntimeState, TrainerVersion } from '@shared/types'

export const RUNTIME_LABEL: Record<TrainerRuntimeState, string> = {
  missing: '环境未安装',
  created: '环境未装完',
  installing: '正在安装环境',
  ready: '环境就绪',
  error: '环境安装失败',
}

export function versionLocation(version: Pick<TrainerVersion, 'hostId'>): string {
  return version.hostId || 'local'
}

/** Versions that live at one location, newest first. */
export function versionsAt(versions: readonly TrainerVersion[], hostId: string): TrainerVersion[] {
  return versions
    .filter((version) => versionLocation(version) === hostId)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** The version training uses by default: the newest ready one, else the newest. */
export function currentVersion(versions: readonly TrainerVersion[], hostId: string): TrainerVersion | undefined {
  const here = versionsAt(versions, hostId)
  return here.find((version) => version.runtimeState === 'ready') ?? here[0]
}

export function defaultBranch(branches: readonly BranchInfo[]): string {
  return branches.find((branch) => branch.isDefault)?.name ?? branches[0]?.name ?? 'main'
}

export type PrepareStep = 'fetch' | 'create' | 'install'

export const PREPARE_STEP_LABEL: Record<PrepareStep, string> = {
  fetch: '正在下载训练器…',
  create: '正在准备新版本…',
  install: '正在安装训练环境，可能需要几分钟…',
}

/** The trainer operations one location supports. Local and SSH hosts differ only in channels. */
export interface TrainerApi {
  branches: () => Promise<BranchInfo[]>
  commits: (branch: string) => Promise<CommitInfo[]>
  create: (branch: string, commit: string) => Promise<TrainerVersion>
  install: (version: TrainerVersion) => Promise<void>
}

type Call = <T>(channel: string, payload?: unknown) => Promise<T>

export function trainerApi(call: Call, hostId: string): TrainerApi {
  if (hostId === 'local') {
    return {
      branches: () => call<BranchInfo[]>(Ipc.trainerBranches),
      commits: (branch) => call<CommitInfo[]>(Ipc.trainerCommits, { branch, limit: 1 }),
      create: (branch, commit) => call<TrainerVersion>(Ipc.trainerCreate, { branch, commit }),
      install: async (version) => {
        await call(Ipc.trainerInstall, { id: version.id })
      },
    }
  }
  return {
    branches: () => call<BranchInfo[]>(Ipc.trainerRemoteBranches, { hostId }),
    commits: (branch) => call<CommitInfo[]>(Ipc.trainerRemoteCommits, { hostId, branch, limit: 1 }),
    create: (branch, commit) => call<TrainerVersion>(Ipc.trainerRemoteCreate, { hostId, branch, commit }),
    install: async (version) => {
      await call(Ipc.trainerRemoteInstall, { hostId, versionId: version.id })
    },
  }
}

export interface PrepareResult {
  version: TrainerVersion
  /** A newer commit than `current` was set up. */
  updated: boolean
  /** The environment was (re)installed during this run. */
  installed: boolean
}

/**
 * Bring a location's trainer up to date in one action: fetch the repository,
 * take the newest commit of the default branch, and install its environment
 * unless that exact version is already ready. Running it again is harmless.
 */
export async function prepareTrainer(
  api: TrainerApi,
  current: TrainerVersion | undefined,
  onStep: (step: PrepareStep) => void = () => undefined,
): Promise<PrepareResult> {
  onStep('fetch')
  const branch = defaultBranch(await api.branches())
  const [latest] = await api.commits(branch)
  if (!latest) throw new Error(`训练器的 ${branch} 分支没有可用的提交`)
  onStep('create')
  const version = await api.create(branch, latest.sha)
  const updated = !current || current.commit !== version.commit
  if (version.runtimeState === 'ready') return { version, updated, installed: false }
  onStep('install')
  await api.install(version)
  return { version: { ...version, runtimeState: 'ready' }, updated, installed: true }
}

/** Optional URL fields (PyTorch and pip sources): empty, or a plain http(s) address. */
export function optionalUrlError(value: string): string | null {
  const text = value.trim()
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '请输入以 http:// 或 https:// 开头的地址'
    return null
  } catch {
    return '请输入以 http:// 或 https:// 开头的地址'
  }
}
