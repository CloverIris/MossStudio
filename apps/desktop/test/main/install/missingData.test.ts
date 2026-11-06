import { describe, expect, it } from 'vitest'
import { missingDataDialog, resolveMissingData, type MissingDataDialog } from '@main/install/missingData'

const PATH = '/Volumes/作品盘/MossStudio'

describe('missingDataDialog', () => {
  it('says plainly where the data was and what to do, with 重试 first and 退出 as cancel', () => {
    const dialog = missingDataDialog(PATH)
    expect(dialog).toMatchObject({ type: 'warning', message: '找不到 MossStudio 的数据位置', buttons: ['重试', '选择其他位置…', '退出'], defaultId: 0, cancelId: 2 })
    expect(dialog.detail).toBe(`数据位置 ${PATH} 现在找不到，可能是存放它的磁盘没有连接。\n\n连接这个磁盘后点“重试”。如果数据已经搬走或不再需要，可以点“选择其他位置”重新设置。`)
    expect(missingDataDialog(PATH, 1).message).toBe('还是找不到 MossStudio 的数据位置')
  })
})

describe('resolveMissingData', () => {
  function run(answers: number[], present: boolean[]) {
    const asked: MissingDataDialog[] = []
    const result = resolveMissingData(PATH, {
      exists: (path) => {
        expect(path).toBe(PATH)
        return present.shift() ?? false
      },
      ask: async (dialog) => {
        asked.push(dialog)
        return answers.shift() ?? 2
      },
    })
    return { result, asked }
  }

  it('重试 asks again while the folder is still missing, and relaunches once it is back', async () => {
    const { result, asked } = run([0, 0], [false, true])
    expect(await result).toBe('relaunch')
    expect(asked.map((dialog) => dialog.message)).toEqual(['找不到 MossStudio 的数据位置', '还是找不到 MossStudio 的数据位置'])
  })

  it('选择其他位置 goes on to Setup; 退出 (or closing the dialog) quits', async () => {
    expect(await run([1], []).result).toBe('setup')
    expect(await run([2], []).result).toBe('quit')
    expect(await run([0, 2], [false]).result).toBe('quit')
  })
})
