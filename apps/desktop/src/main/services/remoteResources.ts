import type { TrainingHost } from '@shared/types'
import { posixQuote, remoteAbsolute, sshExec } from './ssh'

export type RemoteResourceKind = 'engine' | 'models' | 'outputs'

export interface RemoteInspectResult {
  path: string
  exists: boolean
  found?: string
  message: string
}

async function firstMatch(host: TrainingHost, command: string): Promise<string> {
  const result = await sshExec(host, command, 30_000)
  return (
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  )
}

export async function inspectRemoteResource(host: TrainingHost, kind: RemoteResourceKind, inputPath: string): Promise<RemoteInspectResult> {
  const path = await remoteAbsolute(host, inputPath.trim() || '~/.mossstudio')
  if (kind === 'engine') {
    const found = await firstMatch(
      host,
      [
        `test -x ${posixQuote(`${path}/bin/moss-server`)} && echo ${posixQuote(`${path}/bin/moss-server`)} || true`,
        `find ${posixQuote(path)} -maxdepth 4 -type f -name moss-server -perm -111 2>/dev/null | head -n1`,
      ].join('\n'),
    )
    return {
      path,
      exists: Boolean(found),
      found: found || undefined,
      message: found ? `找到引擎：${found}` : '没有找到可执行的 moss-server',
    }
  }
  if (kind === 'models') {
    const found = await firstMatch(
      host,
      [
        `test -f ${posixQuote(`${path}/model_index.json`)} && echo ${posixQuote(path)} || true`,
        `find ${posixQuote(path)} -maxdepth 8 -type f -name model_index.json -printf '%h\\n' 2>/dev/null | head -n1`,
      ].join('\n'),
    )
    return {
      path,
      exists: Boolean(found),
      found: found || undefined,
      message: found ? `找到模型：${found}` : '没有找到完整 model_index.json 的模型目录',
    }
  }
  const found = await firstMatch(host, `test -d ${posixQuote(path)} && echo ${posixQuote(path)} || true`)
  return { path, exists: Boolean(found), found: found || undefined, message: found ? '输出目录存在' : '输出目录不存在' }
}

export async function removeRemoteResource(host: TrainingHost, inputPath: string): Promise<void> {
  const path = await remoteAbsolute(host, inputPath)
  if (!path || path === '/' || path === '/home' || path.split('/').filter(Boolean).length < 3) {
    throw new Error('拒绝删除过短或根路径')
  }
  const result = await sshExec(host, `rm -rf ${posixQuote(path)}`, 120_000)
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().slice(-1200) || '删除失败')
}
