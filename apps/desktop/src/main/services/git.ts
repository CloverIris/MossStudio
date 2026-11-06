import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BranchInfo, CommitInfo, Settings } from '@shared/types'
import { emit } from '../lib/events'
import { paths } from '../lib/paths'
import { firstLine, run, tail } from '../lib/run'
import { gitBinary } from '../lib/gitBinary'
import { Events } from '@shared/channels'
import { DEFAULT_SOURCE } from '@shared/git'
import { applyGitMirror, getLastNetwork } from './network'
import { checkBareMirror } from './gitHealth'

export { DEFAULT_SOURCE }

const ensuring = new Map<string, Promise<void>>()

/** Mirror clones/fetches running right now (the app updater will not restart through them). */
export function mirrorOperationsInFlight(): number {
  return ensuring.size
}

function progress(phase: string, message: string): void {
  emit(Events.gitProgress, { phase, message, at: new Date().toISOString() })
}

function mirrorFor(source: string): string {
  return source === DEFAULT_SOURCE ? paths.mirror() : paths.mirrorForSource(source)
}

async function cloneMirror(source: string, settings: Settings, mirror: string): Promise<void> {
  const mirrorUrl = applyGitMirror(source, settings.gitMirror ?? getLastNetwork()?.selected.git ?? null)
  progress('clone', `正在克隆 ${mirrorUrl}`)
  const result = await run(gitBinary(), ['clone', '--bare', '--progress', mirrorUrl, mirror], {
    timeoutMs: 240_000,
  })
  if (result.code !== 0) {
    if (mirrorUrl !== source) {
      progress('clone', '镜像失败，回退直连 GitHub')
      await rm(mirror, { recursive: true, force: true })
      const direct = await run(gitBinary(), ['clone', '--bare', '--progress', source, mirror], {
        timeoutMs: 240_000,
      })
      if (direct.code === 0) return
      throw new Error(`克隆失败：${tail(direct.stderr) || firstLine(direct.stdout)}`)
    }
    throw new Error(`克隆失败：${tail(result.stderr) || firstLine(result.stdout)}`)
  }
}

async function fetchMirror(mirror: string) {
  return run(gitBinary(), ['-C', mirror, 'fetch', '--prune', 'origin', '+refs/heads/*:refs/heads/*'], { timeoutMs: 180_000 })
}

async function assertHealthy(mirror: string): Promise<void> {
  const health = await checkBareMirror(mirror)
  if (!health.healthy) throw new Error(`镜像不可用：${health.detail ?? '没有可解析的分支'}`)
}

export async function ensureMirror(settings: Settings, source = DEFAULT_SOURCE): Promise<void> {
  const mirror = mirrorFor(source)
  const existing = ensuring.get(mirror)
  if (existing) return existing

  const task = (async () => {
    if (!existsSync(join(mirror, 'HEAD'))) {
      if (existsSync(mirror)) {
        const archived = `${mirror}.broken-${Date.now()}`
        await rename(mirror, archived)
        progress('repair', `残留镜像已保留为 ${archived}`)
      }
      await cloneMirror(source, settings, mirror)
      await assertHealthy(mirror)
      return
    }

    let health = await checkBareMirror(mirror)
    if (!health.healthy) {
      progress('repair', `镜像不完整（${health.detail ?? '未知原因'}），尝试 fetch 修复`)
      await fetchMirror(mirror)
      health = await checkBareMirror(mirror)
      if (!health.healthy) {
        // Keep the broken mirror for forensic/offline recovery instead of deleting
        // objects that may still be useful. Clone a clean mirror at the same path.
        const archived = `${mirror}.broken-${Date.now()}`
        await rename(mirror, archived)
        progress('repair', `fetch 仍不可用，旧镜像已保留为 ${archived}，重新克隆`)
        await cloneMirror(source, settings, mirror)
        await assertHealthy(mirror)
        return
      }
    }

    progress('fetch', '正在拉取最新分支与提交')
    const result = await fetchMirror(mirror)
    if (result.code !== 0) {
      // A fetch failure must not delete a mirror that may still be usable offline.
      progress('fetch', `拉取失败（保留本地镜像）：${firstLine(result.stderr)}`)
    }
  })()

  ensuring.set(mirror, task)
  try {
    await task
  } finally {
    ensuring.delete(mirror)
  }
}

export async function listBranches(source = DEFAULT_SOURCE): Promise<BranchInfo[]> {
  const mirror = mirrorFor(source)
  const result = await run(gitBinary(), ['-C', mirror, 'for-each-ref', '--format=%(refname:short)|%(objectname)|%(HEAD)', 'refs/heads'], {
    timeoutMs: 10_000,
  })
  if (result.code !== 0) {
    throw new Error(`读取分支失败：${tail(result.stderr) || firstLine(result.stdout) || 'git 退出异常'}`)
  }
  const lines = result.stdout.split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) {
    throw new Error('镜像里没有可用分支；请检查网络后重试，或查看诊断中的镜像错误')
  }
  const mainResult = await run(gitBinary(), ['-C', mirror, 'rev-parse', '--verify', 'refs/heads/main'], {
    timeoutMs: 5000,
  })
  const main = firstLine(mainResult.stdout)
  return lines
    .map((line) => {
      const [name = '', sha = '', head = ''] = line.split('|')
      return {
        name,
        sha,
        isDefault: name === 'main' || head.trim() === '*',
        isStable: name === 'main' && sha === main,
      }
    })
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
}

export async function listCommits(branch: string, limit = 60, source = DEFAULT_SOURCE): Promise<CommitInfo[]> {
  const safe = branch.replace(/[^A-Za-z0-9._/-]/g, '')
  const result = await run(gitBinary(), ['-C', mirrorFor(source), 'log', `-n${limit}`, '--format=%H%x1f%h%x1f%ct%x1f%s%x1f%an', safe], {
    timeoutMs: 15_000,
  })
  if (result.code !== 0) {
    throw new Error(`读取提交失败：${tail(result.stderr) || firstLine(result.stdout) || 'git 退出异常'}`)
  }
  if (!result.stdout.trim()) throw new Error(`分支 ${branch || '(空)'} 没有可用提交`)
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', short = '', date = '', subject = '', author = ''] = line.split('\u001f')
      const timestamp = Number.parseInt(date, 10) || 0
      return {
        sha,
        short,
        date: new Date(timestamp * 1000).toISOString(),
        subject,
        author,
      }
    })
}

export async function commitExists(sha: string, source = DEFAULT_SOURCE): Promise<boolean> {
  const result = await run(gitBinary(), ['-C', mirrorFor(source), 'cat-file', '-e', `${sha}^{commit}`], { timeoutMs: 5000 })
  return result.code === 0
}

export async function createWorktree(sha: string, destination: string, source = DEFAULT_SOURCE): Promise<void> {
  const result = await run(gitBinary(), ['-C', mirrorFor(source), 'worktree', 'add', '--detach', destination, sha], { timeoutMs: 90_000 })
  if (result.code !== 0) throw new Error(`创建实例失败：${tail(result.stderr)}`)
}

export async function removeWorktree(destination: string, source = DEFAULT_SOURCE): Promise<void> {
  await run(gitBinary(), ['-C', mirrorFor(source), 'worktree', 'remove', '--force', destination], { timeoutMs: 30_000 })
  await rm(destination, { recursive: true, force: true })
  await run(gitBinary(), ['-C', mirrorFor(source), 'worktree', 'prune'], { timeoutMs: 10_000 })
}

export async function checkout(destination: string, sha: string): Promise<void> {
  const result = await run(gitBinary(), ['-C', destination, 'checkout', '--detach', sha], { timeoutMs: 30_000 })
  if (result.code !== 0) throw new Error(`切换版本失败：${tail(result.stderr)}`)
}

export async function isDirty(destination: string): Promise<boolean> {
  const result = await run(
    gitBinary(),
    ['-C', destination, 'status', '--porcelain', '--', '.', ':(exclude)instance.json', ':(exclude)outputs'],
    { timeoutMs: 10_000 },
  )
  return result.stdout.trim().length > 0
}

export async function branchStableSha(source = DEFAULT_SOURCE): Promise<string | null> {
  const result = await run(gitBinary(), ['-C', mirrorFor(source), 'rev-parse', '--verify', 'refs/heads/main'], { timeoutMs: 5000 })
  return result.code === 0 ? firstLine(result.stdout) || null : null
}
