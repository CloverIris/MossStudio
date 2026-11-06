import type { RunContext } from '../install/runContext'
import type { UpdateContext } from './runtime'

export interface UpdateContextInput {
  run: Pick<RunContext, 'mode' | 'platform' | 'platformKey' | 'packaged' | 'root' | 'launcher' | 'appPath' | 'recordPath' | 'record'>
  /** Trusted keys exist (production or the CI build's test keys). */
  hasKeys: boolean
  exists: (path: string) => boolean
  /** macOS: the folder holding the bundle is writable. */
  writable: (path: string) => boolean
}

/** Whether this copy can update itself, and why not (Chinese, shown in Settings › 更新). */
export function updateContext(input: UpdateContextInput): UpdateContext {
  const { run } = input
  const base = {
    os: run.platform,
    platformKey: run.platformKey,
    root: run.root,
    appPath: run.appPath,
    launcher: run.launcher,
    recordPath: run.recordPath,
  }
  return { ...base, unsupportedReason: unsupportedReason(input) }
}

function unsupportedReason({ run, hasKeys, exists, writable }: UpdateContextInput): string | null {
  if (run.mode === 'dev' || !run.packaged) return '开发版本不能自动更新'
  if (run.mode === 'setup') return '安装程序运行时不检查更新'
  if (run.mode === 'uninstall') return '卸载程序运行时不检查更新'
  if (run.mode === 'loose') return '这份 MossStudio 不是通过安装程序或便携包安装的，无法自动更新，请从发布页下载新版本'
  if (!run.platformKey) return '此平台暂不支持自动更新'
  if (!hasKeys) return '此版本未内置更新签名密钥，无法验证更新'
  if (!run.recordPath || !run.record) return '找不到安装记录（install.json），无法自动更新'
  if (run.platform === 'darwin') {
    if (!writable(run.root ?? run.appPath)) return '应用所在的文件夹不可写，无法自动更新（请把 MossStudio 移到“应用程序”或你有写入权限的文件夹）'
    return null
  }
  if (!run.launcher || !exists(run.launcher)) {
    return run.mode === 'portable'
      ? '便携版需要通过包内的 MossStudio 启动器运行才能自动更新'
      : '找不到 MossStudio 启动器，无法自动更新（请从开始菜单或安装目录中的 MossStudio 启动）'
  }
  return null
}
