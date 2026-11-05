/** Words for the uninstall window and the 卸载 entry in 设置 › 关于. No React here. */
import { bytes } from '../../lib/format'

export function dataChoiceText(input: { dataBytes: number | null; dataRoot: string | null }): string {
  const size = input.dataBytes !== null && input.dataBytes > 0 ? `共 ${bytes(input.dataBytes)}` : null
  const where = input.dataRoot ? `位于 ${input.dataRoot}` : null
  const facts = [size, where].filter(Boolean).join('，')
  return facts
    ? `${facts}。不勾选的话会保留，重新安装后可以继续使用。`
    : '不勾选的话会保留，重新安装后可以继续使用。'
}

export function uninstallSummary(removeData: boolean, method: 'plan' | 'trash'): string {
  const program = method === 'trash' ? 'MossStudio 会被移到废纸篓' : 'MossStudio 的程序文件和快捷方式会被删除'
  return removeData
    ? `${program}，你的作品、模型和设置也会一起删除，无法恢复。`
    : `${program}。你的作品、模型和设置会保留。`
}

export type UninstallEntry =
  /** Settings can uninstall from here. */
  | { kind: 'button' }
  /** Windows without in-app support: point to the system's app list. */
  | { kind: 'system'; text: string }
  /** Portable: nothing is installed, the folder is the app. */
  | { kind: 'portable'; text: string }
  /** Not installed (dev and loose builds): no row at all. */
  | { kind: 'none' }

/**
 * The 卸载 row in 设置 › 关于. On Windows uninstalling belongs to 系统设置 › 应用
 * unless the app can start it; a portable copy is removed by deleting its folder.
 */
export function uninstallEntry(input: { platform: string; info: { portable: boolean } | null; inAppOnWindows: boolean }): UninstallEntry {
  if (!input.info) return { kind: 'none' }
  if (input.info.portable) return { kind: 'portable', text: '这是便携版：关闭 MossStudio 后，删除它所在的文件夹即可。' }
  if (input.platform === 'win32' && !input.inAppOnWindows) {
    return { kind: 'system', text: '在 Windows 的 设置 › 应用 › 已安装的应用 中找到 MossStudio，选择“卸载”。' }
  }
  return { kind: 'button' }
}
