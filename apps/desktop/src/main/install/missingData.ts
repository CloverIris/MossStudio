/**
 * macOS: the locator names this very bundle, but its data root (where install.json lives) is
 * not there, typically on a drive that is not connected. Without this the app would open Setup
 * as if never installed and rewrite the locator to the default data folder, orphaning the data.
 * Instead the user is asked: 重试 (relaunch once the folder is back), 选择其他位置 (Setup, the
 * user's own choice) or 退出. Electron-free: the dialog comes in through `ask`.
 */
export type MissingDataChoice = 'relaunch' | 'setup' | 'quit'

export interface MissingDataDialog {
  type: 'warning'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
}

/** The question; `attempt` > 0 after a 重试 that still found nothing. */
export function missingDataDialog(path: string, attempt = 0): MissingDataDialog {
  return {
    type: 'warning',
    title: 'MossStudio',
    message: attempt > 0 ? '还是找不到 MossStudio 的数据位置' : '找不到 MossStudio 的数据位置',
    detail: `数据位置 ${path} 现在找不到，可能是存放它的磁盘没有连接。\n\n连接这个磁盘后点“重试”。如果数据已经搬走或不再需要，可以点“选择其他位置”重新设置。`,
    buttons: ['重试', '选择其他位置…', '退出'],
    defaultId: 0,
    cancelId: 2,
  }
}

/** Ask until the user picks: 重试 only ends the question once the folder exists again. */
export async function resolveMissingData(
  path: string,
  deps: { exists(path: string): boolean; ask(dialog: MissingDataDialog): Promise<number> },
): Promise<MissingDataChoice> {
  for (let attempt = 0; ; attempt += 1) {
    const choice = await deps.ask(missingDataDialog(path, attempt))
    if (choice === 1) return 'setup'
    if (choice !== 0) return 'quit'
    if (deps.exists(path)) return 'relaunch'
  }
}
