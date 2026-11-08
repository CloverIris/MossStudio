import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { launcherRestartArgs, spawnLauncherRestart, spawnMacSwap } from '@main/update/handoff'
import { MAC_SWAP_HELPER, macSwapArgs, type MacSwapArgs } from '@main/update/macHelper'
import { useTempDir } from '@test/helpers/tempDir'
import { fakeSpawn } from './helpers'

const temp = useTempDir('moss-handoff-')
const unix = process.platform !== 'win32'

describe('launcher handoff', () => {
  it('passes --restart=<pid> as one argument, detached, without a shell, and waits for the spawn', async () => {
    const fake = fakeSpawn()
    const launcher = 'C:\\Users\\张 三\\AppData\\Local\\Programs\\MossStudio\\MossStudio.exe'
    await spawnLauncherRestart(launcher, 4242, fake.spawn)
    expect(launcherRestartArgs(4242)).toEqual(['--restart=4242'])
    expect(fake.calls[0]).toMatchObject({
      command: launcher,
      args: ['--restart=4242'],
      options: { detached: true, stdio: 'ignore', windowsHide: true },
    })
    expect(fake.calls[0]!.options).not.toHaveProperty('shell')
    expect(fake.children[0]!.unrefCalled).toBe(true)
  })

  it('rejects with a clear message when the launcher cannot start', async () => {
    const fake = fakeSpawn({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) })
    await expect(spawnLauncherRestart('/gone/mossstudio', 1, fake.spawn)).rejects.toThrow('无法启动 MossStudio 启动器：spawn ENOENT')
  })

  it('really waits for a real child process', async () => {
    await expect(
      spawnLauncherRestart(process.execPath, 1, (command, _args, options) => nodeSpawn(command, ['-e', ''], options)),
    ).resolves.toBeUndefined()
    await expect(spawnLauncherRestart(join(temp(), 'missing-launcher'), 1)).rejects.toThrow('无法启动 MossStudio 启动器')
  })
})

describe('macOS swap helper: static script, arguments only', () => {
  const args: MacSwapArgs = {
    pid: 77,
    bundle: '/Users/张 三/Applications/MossStudio.app',
    incoming: '/x/.MossStudio-1.1.0.app',
    outgoing: '/x/.MossStudio-1.0.3.app.previous',
    record: '/Users/张 三/Library/Application Support/MossStudio/install.json',
    timeoutSeconds: 60,
    marker: '/m/.update-failed',
    version: '1.1.0',
    from: '1.0.3',
    clean: '/m/.update-clean-exit',
  }

  it('orders the positional arguments as the script reads them', () => {
    expect(macSwapArgs(args)).toEqual([
      '77',
      args.bundle,
      args.incoming,
      args.outgoing,
      args.record,
      '60',
      args.marker,
      '1.1.0',
      '/usr/bin/open',
      '1.0.3',
      args.clean,
    ])
  })

  it('reads every value from $1…$11 and never contains a value', () => {
    for (let i = 1; i <= 9; i += 1) expect(MAC_SWAP_HELPER).toContain(`"$${i}"`)
    expect(MAC_SWAP_HELPER).toContain('"${10}"')
    expect(MAC_SWAP_HELPER).toContain('"${11}"')
    expect(MAC_SWAP_HELPER).not.toContain('MossStudio-1')
    expect(MAC_SWAP_HELPER).not.toMatch(/\beval\b|\bkill -(TERM|KILL|9)\b|pkill/)
    expect(MAC_SWAP_HELPER.startsWith('#!/bin/sh\n')).toBe(true)
  })

  it.runIf(unix)('is valid POSIX sh', () => {
    expect(spawnSync('/bin/sh', ['-n', '-c', MAC_SWAP_HELPER]).status).toBe(0)
  })

  it('writes the script to a private temp file and starts /bin/sh with the arguments once it runs', async () => {
    const fake = fakeSpawn()
    const file = await spawnMacSwap(args, { spawn: fake.spawn, tempDir: temp() })
    expect(readFileSync(file, 'utf8')).toBe(MAC_SWAP_HELPER)
    if (unix) expect(statSync(file).mode & 0o777).toBe(0o700)
    expect(fake.calls[0]).toMatchObject({
      command: '/bin/sh',
      args: [file, ...macSwapArgs(args)],
      options: { detached: true, stdio: 'ignore' },
    })
    expect(fake.children[0]!.unrefCalled).toBe(true)
  })

  it('removes the script and rejects when /bin/sh cannot start', async () => {
    const fake = fakeSpawn({ error: new Error('spawn EACCES') })
    await expect(spawnMacSwap(args, { spawn: fake.spawn, tempDir: temp() })).rejects.toThrow('无法启动更新助手')
    expect(readdirSync(temp())).toEqual([])
  })
})

/**
 * The real helper under /bin/sh against fake bundles. The fake app is Node linked in at
 * MossStudio.app/Contents/MacOS/MossStudio, so `ps` shows it under the bundle path like the real
 * app; the fake `open` starts it and plays the new version's part in install.json. Not a copy of
 * `sleep`: where coreutils is one multi-call binary (uutils, Ubuntu 26.04) a renamed copy refuses
 * to run.
 */
describe.runIf(unix)('macOS swap helper under /bin/sh', () => {
  const started: string[] = []
  afterEach(() => {
    // Stop any fake app still running (the helper itself never kills one).
    const ps = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'command='], { encoding: 'utf8' }).stdout
    for (const line of ps.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (match && started.some((exe) => match[2]!.startsWith(exe))) {
        try {
          process.kill(Number(match[1]))
        } catch {
          // already gone
        }
      }
    }
    started.length = 0
  })

  function bundle(path: string, label: string): void {
    mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true })
    symlinkSync(process.execPath, join(path, 'Contents', 'MacOS', 'MossStudio'))
    writeFileSync(join(path, 'Contents', 'label'), label)
  }

  const record = (current: string, confirmed: boolean): string =>
    `${JSON.stringify({ schema: 1, current, confirmed, failed: [] }, null, 2)}\n`

  type Mode = 'confirm' | 'crash' | 'hang' | 'none' | 'clean' | 'moveon'

  function setup(mode: Mode, options: { recordCurrent?: string } = {}) {
    const folder = join(temp(), 'Applications 应用')
    const data = join(temp(), 'Application Support', 'MossStudio')
    mkdirSync(data, { recursive: true })
    const paths = {
      bundle: join(folder, 'MossStudio.app'),
      incoming: join(folder, '.MossStudio-1.1.0.app'),
      outgoing: join(folder, '.MossStudio-1.0.3.app.previous'),
      record: join(data, 'install.json'),
      marker: join(data, '.update-failed'),
      clean: join(data, '.update-clean-exit'),
      log: join(temp(), 'open.log'),
    }
    bundle(paths.bundle, 'old')
    bundle(paths.incoming, 'new')
    started.push(join(paths.bundle, 'Contents', 'MacOS'))
    writeFileSync(paths.record, record(options.recordCurrent ?? '1.0.3', true))
    const opener = join(temp(), 'fake open')
    // $2 is the bundle `open -n` gets. The fake app reconciles install.json like the real one.
    writeFileSync(
      opener,
      [
        '#!/bin/sh',
        'printf \'%s|\' "$@" >> "$FAKE_OPEN_LOG"',
        'printf \'\\n\' >> "$FAKE_OPEN_LOG"',
        '[ -f "$FAKE_OPENED" ] && exit 0',
        ': > "$FAKE_OPENED"',
        'exe="$2/Contents/MacOS/MossStudio"',
        // The app runs for $1 seconds.
        'app() { "$exe" -e "setTimeout(() => {}, $1 * 1000)" & }',
        'w() { printf \'{\\n  "schema": 1,\\n  "current": "%s",\\n  "confirmed": %s\\n}\\n\' "$1" "$2" > "$FAKE_RECORD.tmp" && mv "$FAKE_RECORD.tmp" "$FAKE_RECORD"; }',
        'case "$FAKE_MODE" in',
        '  confirm) app 30; (sleep 0.3; w 1.1.0 false; sleep 0.3; w 1.1.0 true) & ;;',
        '  crash) w 1.1.0 false; app 0.3 ;;',
        '  hang) w 1.1.0 false; app 30 ;;',
        '  clean) w 1.1.0 false; printf \'1.1.0\\n\' > "$FAKE_CLEAN"; app 0.3 ;;',
        '  moveon) app 30; (w 1.1.0 false; sleep 0.4; w 1.2.0 false) & ;;',
        '  none) ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    const env = {
      ...process.env,
      FAKE_OPEN_LOG: paths.log,
      FAKE_MODE: mode,
      FAKE_RECORD: paths.record,
      FAKE_CLEAN: paths.clean,
      FAKE_OPENED: join(temp(), 'opened-once'),
    }
    return { paths, opener, env }
  }

  async function run(argv: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; script: string; stderr: string }> {
    const script = join(temp(), 'swap.sh')
    writeFileSync(script, MAC_SWAP_HELPER, { mode: 0o700 })
    const child = nodeSpawn('/bin/sh', [script, ...argv], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
    return { code, script, stderr }
  }

  const label = (path: string): string => readFileSync(join(path, 'Contents', 'label'), 'utf8')
  const args = (paths: ReturnType<typeof setup>['paths'], opener: string, patch: Partial<MacSwapArgs> = {}) =>
    macSwapArgs({ ...paths, pid: 999_999_999, timeoutSeconds: 3, version: '1.1.0', from: '1.0.3', opener, ...patch })

  it('waits for the app to exit, swaps, opens the new bundle, exits on confirmation and deletes itself', async () => {
    const { paths, opener, env } = setup('confirm')
    const app = nodeSpawn('/bin/sh', ['-c', 'sleep 0.5'])
    const t0 = Date.now()
    const { code, script } = await run(args(paths, opener, { pid: app.pid!, timeoutSeconds: 10 }), env)
    expect(code).toBe(0)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400)
    expect(label(paths.bundle)).toBe('new')
    expect(label(paths.outgoing)).toBe('old')
    expect(existsSync(paths.incoming)).toBe(false)
    expect(existsSync(paths.marker)).toBe(false)
    expect(readFileSync(paths.log, 'utf8').trim()).toBe(`-n|${paths.bundle}|`)
    expect(existsSync(script)).toBe(false)
  })

  it('rolls back when the new version dies before confirming', async () => {
    const { paths, opener, env } = setup('crash')
    const { code, script } = await run(args(paths, opener), env)
    expect(code).toBe(2)
    expect(label(paths.bundle)).toBe('old')
    expect(label(paths.incoming)).toBe('new')
    expect(existsSync(paths.outgoing)).toBe(false)
    expect(readFileSync(paths.marker, 'utf8').trim()).toBe('1.1.0')
    expect(readFileSync(paths.log, 'utf8').trim().split('\n')).toEqual([`-n|${paths.bundle}|`, `-n|${paths.bundle}|`])
    expect(existsSync(script)).toBe(false)
  }, 15_000)

  it('rolls back when the new version never starts', async () => {
    const { paths, opener, env } = setup('none')
    const { code } = await run(args(paths, opener, { timeoutSeconds: 1 }), env)
    expect(code).toBe(2)
    expect(label(paths.bundle)).toBe('old')
    expect(readFileSync(paths.marker, 'utf8').trim()).toBe('1.1.0')
  }, 15_000)

  it('never kills a live, unconfirmed app: at the timeout it is left running', async () => {
    const { paths, opener, env } = setup('hang')
    const { code } = await run(args(paths, opener, { timeoutSeconds: 1 }), env)
    expect(code).toBe(3)
    expect(label(paths.bundle)).toBe('new')
    expect(existsSync(paths.marker)).toBe(false)
    const ps = spawnSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' }).stdout
    expect(ps.split('\n').some((line) => line.startsWith(join(paths.bundle, 'Contents', 'MacOS')))).toBe(true)
  }, 15_000)

  it('leaves a version that quit cleanly before confirming', async () => {
    const { paths, opener, env } = setup('clean')
    const { code } = await run(args(paths, opener), env)
    expect(code).toBe(3)
    expect(label(paths.bundle)).toBe('new')
    expect(existsSync(paths.marker)).toBe(false)
    expect(existsSync(paths.clean)).toBe(false)
  }, 15_000)

  it('stops quietly once install.json has moved on to another version', async () => {
    const { paths, opener, env } = setup('moveon')
    const { code } = await run(args(paths, opener), env)
    expect(code).toBe(4)
    expect(label(paths.bundle)).toBe('new')
    expect(existsSync(paths.marker)).toBe(false)
  }, 15_000)

  it('moves nothing when install.json no longer names the version that asked (a stale helper)', async () => {
    const { paths, opener, env } = setup('hang', { recordCurrent: '1.0.9' })
    const { code, script } = await run(args(paths, opener), env)
    expect(code).toBe(4)
    expect(label(paths.bundle)).toBe('old')
    expect(label(paths.incoming)).toBe('new')
    expect(existsSync(paths.outgoing)).toBe(false)
    expect(existsSync(script)).toBe(false)
  })

  it('reopens the old bundle untouched when the incoming bundle is missing', async () => {
    const { paths, opener, env } = setup('none')
    const { code } = await run(args(paths, opener, { incoming: join(temp(), 'nope.app') }), env)
    expect(code).toBe(1)
    expect(label(paths.bundle)).toBe('old')
  })
})
