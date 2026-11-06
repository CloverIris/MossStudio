import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { helpersToKill, isChromiumHelper, parseProcStat, parsePsTable, processTable, type ProcessEntry } from '@main/install/processTree'

const EXE = '/home/a/MossStudio/app-2.0.0/MossStudio'

describe('parsing', () => {
  it('parses /proc/<pid>/stat, including a comm with spaces and parentheses', () => {
    expect(parseProcStat('4242 (MossStudio) S 4000 4242 4242 0 -1')).toEqual({ pid: 4242, ppid: 4000 })
    expect(parseProcStat('77 (a (b) c) R 42 77 77 0')).toEqual({ pid: 77, ppid: 42 })
    expect(parseProcStat('garbage')).toBeNull()
  })

  it('parses ps output with executable paths that contain spaces', () => {
    expect(
      parsePsTable(
        '  1     0 /sbin/launchd\n 501   1 /Applications/MossStudio.app/Contents/Frameworks/MossStudio Helper (GPU).app/Contents/MacOS/MossStudio Helper (GPU)\n\n',
      ),
    ).toEqual([
      { pid: 1, ppid: 0, exe: '/sbin/launchd' },
      {
        pid: 501,
        ppid: 1,
        exe: '/Applications/MossStudio.app/Contents/Frameworks/MossStudio Helper (GPU).app/Contents/MacOS/MossStudio Helper (GPU)',
      },
    ])
  })
})

describe('isChromiumHelper', () => {
  it('Linux: our own binary and the sandbox/crashpad helpers beside it only', () => {
    expect(isChromiumHelper('linux', EXE, EXE)).toBe(true)
    expect(isChromiumHelper('linux', '/home/a/MossStudio/app-2.0.0/chrome_crashpad_handler', EXE)).toBe(true)
    expect(isChromiumHelper('linux', '/home/a/MossStudio/app-2.0.0/chrome-sandbox', EXE)).toBe(true)
    expect(isChromiumHelper('linux', '/home/a/MossStudio/mossstudio', EXE)).toBe(false) // the launcher
    expect(isChromiumHelper('linux', '/tmp/MossStudio-uninstall-x/mossstudio', EXE)).toBe(false) // its temp copy
    expect(isChromiumHelper('linux', '/home/a/MossStudio/app-2.1.0/MossStudio', EXE)).toBe(false) // another version
    expect(isChromiumHelper('linux', null, EXE)).toBe(false)
  })

  it('macOS: the main executable and the Helper apps in Contents/Frameworks', () => {
    const main = '/Volumes/MossStudio/MossStudio.app/Contents/MacOS/MossStudio'
    const frameworks = '/Volumes/MossStudio/MossStudio.app/Contents/Frameworks'
    expect(isChromiumHelper('darwin', main, main)).toBe(true)
    expect(isChromiumHelper('darwin', `${frameworks}/MossStudio Helper (GPU).app/Contents/MacOS/MossStudio Helper (GPU)`, main)).toBe(true)
    expect(isChromiumHelper('darwin', `${frameworks}/MossStudio Helper.app/Contents/MacOS/MossStudio Helper`, main)).toBe(true)
    expect(isChromiumHelper('darwin', '/usr/bin/open', main)).toBe(false)
    expect(isChromiumHelper('darwin', '/bin/sh', main)).toBe(false)
    expect(isChromiumHelper('darwin', '/Applications/MossStudio.app/Contents/MacOS/MossStudio', main)).toBe(false) // the installed app
  })
})

describe('helpersToKill', () => {
  const ours = (entry: ProcessEntry): boolean => isChromiumHelper('linux', entry.exe, EXE)
  const table: ProcessEntry[] = [
    { pid: 1, ppid: 0, exe: '/sbin/init' },
    { pid: 100, ppid: 1, exe: EXE }, // the setup/uninstall browser process
    { pid: 101, ppid: 100, exe: EXE }, // gpu-process
    { pid: 102, ppid: 101, exe: EXE }, // broker (child of the GPU process)
    { pid: 103, ppid: 100, exe: EXE }, // network utility
    { pid: 104, ppid: 100, exe: EXE },
    { pid: 105, ppid: 104, exe: EXE }, // zygote and its child
    { pid: 106, ppid: 100, exe: '/home/a/MossStudio/app-2.0.0/chrome_crashpad_handler' },
    { pid: 110, ppid: 100, exe: '/tmp/MossStudio-uninstall-x/mossstudio' }, // temp launcher, --finish-uninstall
    { pid: 111, ppid: 110, exe: '/bin/sleep' },
    { pid: 120, ppid: 100, exe: '/home/a/MossStudio/mossstudio' }, // installed launcher (setup's launch)
    { pid: 121, ppid: 120, exe: '/home/a/MossStudio/app-2.0.0/MossStudio' }, // ...and the app it starts (same exe!)
    { pid: 200, ppid: 1, exe: EXE }, // another MossStudio, not ours
  ]

  it('kills gpu-process, broker, utilities, zygotes and crashpad; never what we spawned or below it', () => {
    const kill = helpersToKill(100, table, new Set([110, 120]), ours)
    expect(kill.sort((a, b) => a - b)).toEqual([101, 102, 103, 104, 105, 106])
    for (const pid of [110, 111, 120, 121, 200, 1]) expect(kill).not.toContain(pid)
  })

  it('the executable check alone already spares a spawned launcher, and the pid record alone spares a same-exe child', () => {
    expect(helpersToKill(100, table, new Set(), ours)).not.toContain(110)
    expect(helpersToKill(100, table, new Set(), ours)).not.toContain(120)
    // Without the pid record, a spawned child running our own binary would be taken for a helper:
    const sameExe: ProcessEntry[] = [
      { pid: 100, ppid: 1, exe: EXE },
      { pid: 130, ppid: 100, exe: EXE },
    ]
    expect(helpersToKill(100, sameExe, new Set(), ours)).toEqual([130])
    expect(helpersToKill(100, sameExe, new Set([130]), ours)).toEqual([])
  })
})

describe('on a real Linux process table', () => {
  const children: ChildProcess[] = []
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL')
  })

  it('excludes a detached "launcher" we spawned and keeps a same-binary helper', async () => {
    if (process.platform !== 'linux') {
      expect(processTable()).toEqual(process.platform === 'darwin' ? expect.any(Array) : [])
      return
    }
    const launcher = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    children.push(launcher, helper)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const table = processTable()
    expect(table.find((entry) => entry.pid === launcher.pid)?.ppid).toBe(process.pid)
    const isOurs = (entry: ProcessEntry): boolean => isChromiumHelper('linux', entry.exe, process.execPath)
    const spawnedOnPurpose = new Set([launcher.pid!])
    const kill = helpersToKill(process.pid, table, spawnedOnPurpose, isOurs)
    expect(kill).not.toContain(launcher.pid)
    expect(kill).toContain(helper.pid)
    // The executable check by itself also spares `sleep`.
    expect(helpersToKill(process.pid, table, new Set(), isOurs)).not.toContain(launcher.pid)
  })
})
