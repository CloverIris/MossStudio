import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { EngineInstallAttempt, EngineInstallProgress } from '@shared/types'
import { engineBinaryName, type EnginePackageKind } from '@shared/enginePackages'
import { isLockedError, renameWithRetry, writeFileAtomic } from './atomicWrite'

export interface EngineInstallPromotion {
  installDir: string
  backupDir?: string
  trashDir?: string
}

interface PendingJournal {
  schemaVersion: 1
  stamp: string
  installDir: string
  stagingDir: string
  previousDir?: string
}

export interface EngineStoreOps {
  mkdir(path: string): Promise<void>
  readFile(path: string): Promise<string>
  rename(from: string, to: string): Promise<void>
  rm(path: string): Promise<void>
  writeFile(path: string, contents: string): Promise<void>
}

export interface EngineStoreOptions {
  ops?: Partial<EngineStoreOps>
  retryDelayMs?: number
}

const defaultOps: EngineStoreOps = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true })
  },
  readFile: async (path) => readFile(path, 'utf8'),
  rename: async (from, to) => {
    await rename(from, to)
  },
  rm: async (path) => {
    await rm(path, { recursive: true, force: true })
  },
  writeFile: async (path, contents) => {
    await writeFile(path, contents, 'utf8')
  },
}

function isInside(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function renameRetrying(from: string, to: string, ops: EngineStoreOps, retryDelayMs: number): Promise<void> {
  return renameWithRetry(from, to, { rename: ops.rename, delayMs: retryDelayMs })
}

function atomicWriteJson(file: string, value: unknown, ops: EngineStoreOps, retryDelayMs: number): Promise<void> {
  return writeFileAtomic(file, JSON.stringify(value, null, 2), {
    writeFile: ops.writeFile,
    rename: ops.rename,
    rm: ops.rm,
    delayMs: retryDelayMs,
  })
}

async function bestEffortRm(path: string | undefined, ops: EngineStoreOps): Promise<void> {
  if (!path) return
  try {
    await ops.rm(path)
  } catch {
    // 清尾失败不覆盖安装结果，启动恢复会再次处理。
  }
}

let activeInstall: EngineInstallProgress | null = null

export function setEngineInstallProgress(progress: EngineInstallProgress | null): void {
  activeInstall = progress
}

export function getEngineInstallProgress(): EngineInstallProgress | null {
  return activeInstall
}

export function readEngineLastAttempt(root: string): EngineInstallAttempt | null {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'last-attempt.json'), 'utf8')) as Partial<EngineInstallAttempt>
    return typeof raw.at === 'string' ? (raw as EngineInstallAttempt) : null
  } catch {
    return null
  }
}

export function writeEngineLastAttempt(root: string, attempt: EngineInstallAttempt): void {
  mkdirSync(root, { recursive: true })
  const file = join(root, 'last-attempt.json')
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(attempt, null, 2), 'utf8')
  renameSync(temporary, file)
}

export function isManagedEngineDirectory(name: string): boolean {
  return !name.startsWith('.')
}

export function engineServerPath(installDir: string): string {
  return join(installDir, 'bin', process.platform === 'win32' ? 'moss-server.exe' : 'moss-server')
}

/** The program a package of this kind runs: bin/moss-server, bin/moss-infer-vulkan or bin/moss-infer-hip. */
export function engineBinaryPath(installDir: string, kind: EnginePackageKind): string {
  return join(installDir, 'bin', engineBinaryName(kind, process.platform))
}

/** 只有完成安装检查的 staging 才能晋升；settings 由调用方在成功后更新。 */
export async function promoteInstall(
  input: {
    root: string
    stagingDir: string
    stamp: string
    currentServerPath: string | null
    beforeReplace?: () => Promise<void>
  },
  options: EngineStoreOptions = {},
): Promise<EngineInstallPromotion> {
  const ops: EngineStoreOps = { ...defaultOps, ...options.ops }
  const retryDelayMs = options.retryDelayMs ?? 200
  const root = resolve(input.root)
  const stagingDir = resolve(input.stagingDir)
  const stagingRoot = join(root, '.staging')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.stamp)) throw new Error('引擎 stamp 无效')
  if (!isInside(stagingRoot, stagingDir) || stagingDir === resolve(stagingRoot)) {
    throw new Error('引擎暂存目录必须位于 .staging 内')
  }
  if (!existsSync(stagingDir)) throw new Error('引擎暂存目录不存在')

  const installDir = join(root, input.stamp)
  const replacingCurrent = Boolean(input.currentServerPath && isInside(installDir, input.currentServerPath))
  const unique = `${input.stamp}-${Date.now()}`
  const previousDir = existsSync(installDir) ? join(root, replacingCurrent ? '.backup' : '.trash', unique) : undefined
  const journalPath = join(root, '.pending.json')
  const journal: PendingJournal = {
    schemaVersion: 1,
    stamp: input.stamp,
    installDir,
    stagingDir,
    previousDir,
  }
  let movedPrevious = false
  let promoted = false
  try {
    await ops.mkdir(stagingRoot)
    if (previousDir) await ops.mkdir(join(previousDir, '..'))
    await atomicWriteJson(journalPath, journal, ops, retryDelayMs)
    if (replacingCurrent && previousDir && input.beforeReplace) await input.beforeReplace()
    if (previousDir) {
      await renameRetrying(installDir, previousDir, ops, retryDelayMs)
      movedPrevious = true
    }
    await renameRetrying(stagingDir, installDir, ops, retryDelayMs)
    promoted = true
    await bestEffortRm(journalPath, ops)
    return {
      installDir,
      backupDir: replacingCurrent ? previousDir : undefined,
      trashDir: replacingCurrent ? undefined : previousDir,
    }
  } catch (error) {
    if (!promoted) {
      let rollbackError: unknown
      if (movedPrevious && previousDir && existsSync(previousDir) && !existsSync(installDir)) {
        try {
          await renameRetrying(previousDir, installDir, ops, retryDelayMs)
        } catch (cause) {
          rollbackError = cause
        }
      }
      await bestEffortRm(stagingDir, ops)
      if (!rollbackError) await bestEffortRm(journalPath, ops)
      const currentMessage = replacingCurrent && isLockedError(error) ? '引擎正在使用，无法替换旧目录' : '引擎目录晋升失败'
      const rollbackMessage = rollbackError
        ? `；自动回滚也失败，已保留 .pending.json 供下次启动恢复：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        : ''
      throw new Error(`${currentMessage}：${error instanceof Error ? error.message : String(error)}${rollbackMessage}`, { cause: error })
    }
    throw error
  }
}

/** settings 更新成功后清理旧版本；失败留待启动恢复，不影响新引擎。 */
export async function cleanupPromotedInstall(promotion: EngineInstallPromotion, options: EngineStoreOptions = {}): Promise<void> {
  const ops: EngineStoreOps = { ...defaultOps, ...options.ops }
  await bestEffortRm(promotion.backupDir ?? promotion.trashDir, ops)
}

/** 在 app.whenReady 早期恢复上次中断的目录事务。 */
export async function recoverEngineInstall(
  rootInput: string,
  options: EngineStoreOptions = {},
): Promise<{ restored: string[]; cleaned: string[] }> {
  const ops: EngineStoreOps = { ...defaultOps, ...options.ops }
  const retryDelayMs = options.retryDelayMs ?? 200
  const root = resolve(rootInput)
  const journalPath = join(root, '.pending.json')
  const restored: string[] = []
  const cleaned: string[] = []
  await ops.mkdir(root)

  if (existsSync(journalPath)) {
    let journal: PendingJournal
    try {
      journal = JSON.parse(await ops.readFile(journalPath)) as PendingJournal
    } catch {
      await bestEffortRm(journalPath, ops)
      journal = { schemaVersion: 1, stamp: '', installDir: '', stagingDir: '' }
    }
    if (journal.installDir) {
      const safePaths = [journal.installDir, journal.stagingDir, journal.previousDir]
        .filter((path): path is string => Boolean(path))
        .every((path) => isInside(root, path) && resolve(path) !== root)
      if (!safePaths) throw new Error('引擎安装日志包含越界路径，已停止自动恢复')
      if (!existsSync(journal.installDir) && journal.previousDir && existsSync(journal.previousDir)) {
        await renameRetrying(journal.previousDir, journal.installDir, ops, retryDelayMs)
        restored.push(journal.installDir)
      } else if (existsSync(journal.installDir) && journal.previousDir) {
        await bestEffortRm(journal.previousDir, ops)
        cleaned.push(journal.previousDir)
      }
      if (existsSync(journal.stagingDir)) {
        await bestEffortRm(journal.stagingDir, ops)
        cleaned.push(journal.stagingDir)
      }
    }
    await bestEffortRm(journalPath, ops)
  }

  for (const name of ['.staging', '.trash', '.backup']) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    await bestEffortRm(path, ops)
    cleaned.push(path)
  }
  return { restored, cleaned }
}
