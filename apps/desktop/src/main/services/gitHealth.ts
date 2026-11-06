import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { firstLine, run } from '../lib/run'
import { gitBinary } from '../lib/gitBinary'

export interface MirrorHealth {
  healthy: boolean
  branches: number
  detail?: string
}

/**
 * A bare mirror is usable only when at least one local branch resolves to a
 * commit. `HEAD` may exist while it points at `refs/heads/.invalid` after an
 * interrupted clone, so the file alone is not a health signal.
 */
export async function checkBareMirror(mirror: string): Promise<MirrorHealth> {
  if (!existsSync(join(mirror, 'HEAD'))) {
    return { healthy: false, branches: 0, detail: '镜像缺少 HEAD' }
  }
  const refs = await run(gitBinary(), ['-C', mirror, 'for-each-ref', '--format=%(refname)', 'refs/heads'], { timeoutMs: 5000 })
  if (refs.code !== 0) {
    return {
      healthy: false,
      branches: 0,
      detail: firstLine(refs.stderr) || '读取分支引用失败',
    }
  }
  const branches = refs.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (const branch of branches) {
    const resolved = await run(gitBinary(), ['-C', mirror, 'rev-parse', '--verify', `${branch}^{commit}`], { timeoutMs: 5000 })
    if (resolved.code === 0 && firstLine(resolved.stdout)) {
      return { healthy: true, branches: branches.length }
    }
  }
  return {
    healthy: false,
    branches: branches.length,
    detail: branches.length ? '分支引用存在但没有可解析的 commit' : '镜像中没有本地分支',
  }
}
