import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BranchInfo, CommitInfo, Settings } from '@shared/types'
import { paths } from '../lib/paths'
import { firstLine, run, tail } from '../lib/run'
import { gitBinary } from '../lib/gitBinary'

export const GBC_SOURCE = 'https://github.com/KohakuBlueleaf/KohakuGBC.git'

export interface GbcVersion {
  id: string
  name: string
  branch: string
  commit: string
  shortCommit: string
  subject: string
  commitDate: string
  path: string
  createdAt: string
}

function root(settings: Settings): string {
  return settings.gbcRoot ?? join(paths.root(), 'gbc')
}
function mirror(settings: Settings): string {
  return join(root(settings), 'git', 'kohakugbc.git')
}
function versionsRoot(settings: Settings): string {
  return join(root(settings), 'versions')
}
function metaPath(settings: Settings, id: string): string {
  return join(versionsRoot(settings), `${id}.json`)
}

async function fetchMirror(settings: Settings): Promise<void> {
  const m = mirror(settings)
  await mkdir(join(root(settings), 'git'), { recursive: true })
  if (!existsSync(join(m, 'HEAD'))) {
    const clone = await run(gitBinary(), ['clone', '--bare', '--progress', GBC_SOURCE, m], { timeoutMs: 240_000 })
    if (clone.code !== 0) throw new Error(`GBC 克隆失败：${tail(clone.stderr) || firstLine(clone.stdout)}`)
    return
  }
  const fetch = await run(gitBinary(), ['-C', mirror(settings), 'fetch', '--prune', 'origin', '+refs/heads/*:refs/heads/*'], {
    timeoutMs: 180_000,
  })
  if (fetch.code !== 0 && !existsSync(join(m, 'refs', 'heads', 'main'))) {
    throw new Error(`GBC 更新失败：${tail(fetch.stderr) || firstLine(fetch.stdout)}`)
  }
}

export async function listGbcBranches(settings: Settings): Promise<BranchInfo[]> {
  await fetchMirror(settings)
  const result = await run(gitBinary(), ['-C', mirror(settings), 'for-each-ref', '--format=%(refname:short)|%(objectname)', 'refs/heads'], {
    timeoutMs: 15_000,
  })
  if (result.code !== 0) throw new Error(`读取 GBC 分支失败：${tail(result.stderr)}`)
  const rows = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name = '', sha = ''] = line.split('|')
      return { name, sha, isDefault: name === 'main', isStable: name === 'main' }
    })
  if (!rows.length) throw new Error('GBC 镜像没有可用分支')
  return rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
}

export async function listGbcCommits(settings: Settings, branch: string, limit = 60): Promise<CommitInfo[]> {
  const safe = branch.replace(/[^A-Za-z0-9._/-]/g, '')
  const result = await run(gitBinary(), ['-C', mirror(settings), 'log', `-n${limit}`, '--format=%H%x1f%h%x1f%ct%x1f%s%x1f%an', safe], {
    timeoutMs: 15_000,
  })
  if (result.code !== 0) throw new Error(`读取 GBC 提交失败：${tail(result.stderr)}`)
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', short = '', date = '', subject = '', author = ''] = line.split('\u001f')
      const timestamp = Number.parseInt(date, 10) || 0
      return { sha, short, date: new Date(timestamp * 1000).toISOString(), subject, author }
    })
}

export async function listGbcVersions(settings: Settings): Promise<GbcVersion[]> {
  await mkdir(versionsRoot(settings), { recursive: true })
  const files = (await readdir(versionsRoot(settings))).filter((file) => file.endsWith('.json'))
  const rows: GbcVersion[] = []
  for (const file of files) {
    try {
      rows.push(JSON.parse(await readFile(join(versionsRoot(settings), file), 'utf8')) as GbcVersion)
    } catch {
      /* ignore corrupt */
    }
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function createGbcVersion(settings: Settings, branch: string, sha: string, name?: string): Promise<GbcVersion> {
  await fetchMirror(settings)
  const commit = await run(gitBinary(), ['-C', mirror(settings), 'log', '-1', '--format=%H%x1f%h%x1f%ct%x1f%s', sha], { timeoutMs: 10_000 })
  if (commit.code !== 0) throw new Error('GBC commit 不存在')
  const [full = sha, short = sha.slice(0, 8), stamp = '0', subject = ''] = firstLine(commit.stdout).split('\u001f')
  const id = `gbc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const destination = join(versionsRoot(settings), id)
  const result = await run(gitBinary(), ['-C', mirror(settings), 'worktree', 'add', '--detach', destination, full], { timeoutMs: 120_000 })
  if (result.code !== 0) throw new Error(`创建 GBC 版本失败：${tail(result.stderr)}`)
  const version: GbcVersion = {
    id,
    name: name?.trim() || `GBC ${short}`,
    branch,
    commit: full,
    shortCommit: short,
    subject,
    commitDate: new Date((Number.parseInt(stamp, 10) || 0) * 1000).toISOString(),
    path: destination,
    createdAt: new Date().toISOString(),
  }
  await writeFile(metaPath(settings, id), JSON.stringify(version, null, 2), 'utf8')
  return version
}

export async function removeGbcVersion(settings: Settings, id: string): Promise<void> {
  const version = (await listGbcVersions(settings)).find((item) => item.id === id)
  if (!version) return
  await run(gitBinary(), ['-C', mirror(settings), 'worktree', 'remove', '--force', version.path], { timeoutMs: 30_000 })
  await rm(version.path, { recursive: true, force: true })
  await rm(metaPath(settings, id), { force: true })
}
