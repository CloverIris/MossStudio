import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BranchInfo, CommitInfo, Settings } from '@shared/types'
import { Events } from '@shared/channels'
import { emit } from '../lib/events'
import { paths } from '../lib/paths'
import { firstLine, run, tail } from '../lib/run'
import { gitBinary } from '../lib/gitBinary'
import { applyGitMirror, getLastNetwork } from './network'
import { checkBareMirror } from './gitHealth'

export const TRAINER_SOURCE = 'https://github.com/KohakuBlueleaf/KohakuMossTrainer'
const ensuring = new Map<string, Promise<void>>()

/** Mirror clones/fetches running right now (the app updater will not restart through them). */
export function mirrorOperationsInFlight(): number {
  return ensuring.size
}

function root(settings: Settings): string {
  return paths.trainerRoot(settings.trainerRoot)
}

export function trainerMirror(settings: Settings): string {
  return join(root(settings), 'git', 'kohaku-trainer.git')
}

export function trainerVersionsDir(settings: Settings): string {
  return join(root(settings), 'versions')
}

export function trainerVersionDir(settings: Settings, id: string): string {
  return join(trainerVersionsDir(settings), id)
}

export function trainerRuntimesDir(settings: Settings): string {
  return join(root(settings), 'runtimes')
}

export function trainerRuntimeDir(settings: Settings, id: string): string {
  return join(trainerRuntimesDir(settings), id)
}

function progress(message: string): void {
  emit(Events.gitProgress, { phase: 'trainer', message, at: new Date().toISOString() })
}

async function cloneMirror(settings: Settings, source = TRAINER_SOURCE): Promise<void> {
  const mirror = trainerMirror(settings)
  const mirrorUrl = applyGitMirror(source, settings.gitMirror ?? getLastNetwork()?.selected.git ?? null)
  await mkdir(join(mirror, '..'), { recursive: true })
  progress(`正在克隆 ${mirrorUrl}`)
  const result = await run(gitBinary(), ['clone', '--bare', '--progress', mirrorUrl, mirror], { timeoutMs: 240_000 })
  if (result.code === 0) return
  if (mirrorUrl !== source) {
    await rm(mirror, { recursive: true, force: true })
    const direct = await run(gitBinary(), ['clone', '--bare', '--progress', source, mirror], { timeoutMs: 240_000 })
    if (direct.code === 0) return
    throw new Error(`训练器克隆失败：${tail(direct.stderr) || firstLine(direct.stdout)}`)
  }
  throw new Error(`训练器克隆失败：${tail(result.stderr) || firstLine(result.stdout)}`)
}

async function fetchTrainerMirror(settings: Settings) {
  return run(
    gitBinary(),
    ['-C', trainerMirror(settings), 'fetch', '--prune', '--tags', 'origin', '+refs/heads/*:refs/heads/*'],
    { timeoutMs: 180_000 },
  )
}

async function assertTrainerHealthy(settings: Settings): Promise<void> {
  const health = await checkBareMirror(trainerMirror(settings))
  if (!health.healthy) throw new Error(`训练器镜像不可用：${health.detail ?? '没有可解析的分支'}`)
}

export async function ensureTrainerMirror(settings: Settings): Promise<void> {
  const key = root(settings)
  const pending = ensuring.get(key)
  if (pending) return pending
  const task = (async () => {
    const mirror = trainerMirror(settings)
    if (!existsSync(join(mirror, 'HEAD'))) {
      if (existsSync(mirror)) {
        const archived = `${mirror}.broken-${Date.now()}`
        await rename(mirror, archived)
        progress(`残留训练器镜像已保留为 ${archived}`)
      }
      await cloneMirror(settings)
      await assertTrainerHealthy(settings)
      return
    }
    let health = await checkBareMirror(mirror)
    if (!health.healthy) {
      progress(`训练器镜像不完整（${health.detail ?? '未知原因'}），尝试 fetch 修复`)
      await fetchTrainerMirror(settings)
      health = await checkBareMirror(mirror)
      if (!health.healthy) {
        const archived = `${mirror}.broken-${Date.now()}`
        await rename(mirror, archived)
        progress(`fetch 仍不可用，旧训练器镜像已保留为 ${archived}，重新克隆`)
        await cloneMirror(settings)
        await assertTrainerHealthy(settings)
        return
      }
    }
    progress('正在拉取训练器分支与标签')
    const result = await fetchTrainerMirror(settings)
    if (result.code !== 0) progress(`拉取失败（保留本地镜像）：${firstLine(result.stderr)}`)
  })().finally(() => ensuring.delete(key))
  ensuring.set(key, task)
  return task
}

export async function listTrainerBranches(settings: Settings): Promise<BranchInfo[]> {
  await ensureTrainerMirror(settings)
  const mirror = trainerMirror(settings)
  const result = await run(gitBinary(), ['-C', mirror, 'for-each-ref', '--format=%(refname:short)|%(objectname)', 'refs/heads'], { timeoutMs: 10_000 })
  if (result.code !== 0) throw new Error(`读取训练器分支失败：${tail(result.stderr) || firstLine(result.stdout)}`)
  const branches = result.stdout.split(/\r?\n/).filter(Boolean)
  if (branches.length === 0) throw new Error('训练器镜像里没有可用分支')
  const tag = await run(gitBinary(), ['-C', mirror, 'rev-parse', '--verify', 'refs/tags/v0.1.0^{commit}'], { timeoutMs: 5000 })
  const stable = tag.code === 0 ? firstLine(tag.stdout) : ''
  return branches
    .map((line) => {
      const [name = '', sha = ''] = line.split('|')
      return { name, sha, isDefault: name === 'main', isStable: Boolean(stable) && sha === stable }
    })
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
}

export async function listTrainerCommits(settings: Settings, branch: string, limit = 60): Promise<CommitInfo[]> {
  await ensureTrainerMirror(settings)
  const safe = branch.replace(/[^A-Za-z0-9._/-]/g, '')
  const result = await run(
    gitBinary(),
    ['-C', trainerMirror(settings), 'log', `-n${limit}`, '--format=%H%x1f%h%x1f%ct%x1f%s%x1f%an', safe],
    { timeoutMs: 15_000 },
  )
  if (result.code !== 0) throw new Error(`读取训练器提交失败：${tail(result.stderr) || firstLine(result.stdout)}`)
  if (!result.stdout.trim()) throw new Error(`训练器分支 ${branch || '(空)'} 没有可用提交`)
  return result.stdout
    .split('\n')
    .filter(Boolean)
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

export async function trainerTagSha(settings: Settings, tag = 'v0.1.0'): Promise<string | null> {
  const result = await run(gitBinary(), ['-C', trainerMirror(settings), 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { timeoutMs: 5000 })
  return result.code === 0 ? firstLine(result.stdout) || null : null
}

export async function trainerCommitExists(settings: Settings, sha: string): Promise<boolean> {
  const result = await run(gitBinary(), ['-C', trainerMirror(settings), 'cat-file', '-e', `${sha}^{commit}`], { timeoutMs: 5000 })
  return result.code === 0
}

export async function createTrainerWorktree(settings: Settings, sha: string, destination: string): Promise<void> {
  await mkdir(trainerVersionsDir(settings), { recursive: true })
  const result = await run(gitBinary(), ['-C', trainerMirror(settings), 'worktree', 'add', '--detach', destination, sha], { timeoutMs: 120_000 })
  if (result.code !== 0) throw new Error(`创建训练版本失败：${tail(result.stderr)}`)
}

export async function removeTrainerWorktree(settings: Settings, destination: string): Promise<void> {
  await run(gitBinary(), ['-C', trainerMirror(settings), 'worktree', 'remove', '--force', destination], { timeoutMs: 30_000 })
  await rm(destination, { recursive: true, force: true })
  await run(gitBinary(), ['-C', trainerMirror(settings), 'worktree', 'prune'], { timeoutMs: 10_000 })
}

export async function isTrainerDirty(destination: string): Promise<boolean> {
  const result = await run(
    gitBinary(),
    ['-C', destination, 'status', '--porcelain', '--', '.', ':(exclude)trainer.json', ':(exclude)runs', ':(exclude)configs/user', ':(exclude)models', ':(exclude).venv'],
    { timeoutMs: 10_000 },
  )
  return result.stdout.trim().length > 0
}
