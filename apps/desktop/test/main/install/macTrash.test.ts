import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAC_TRASH_HELPER, trashBundleAfterExit } from '@main/install/macTrash'
import { useTempDir } from '@test/helpers/tempDir'

const posix = process.platform !== 'win32'

describe.runIf(posix)('MAC_TRASH_HELPER', () => {
  const temp = useTempDir()

  /** Runs the script with a pid that is already gone. Without osascript (Linux) it uses the ~/.Trash fallback. */
  function runHelper(home: string, bundle: string, pid = '999999') {
    const script = join(temp(), 'trash.sh')
    writeFileSync(script, MAC_TRASH_HELPER, { mode: 0o700 })
    const result = spawnSync('/bin/sh', [script, pid, bundle], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20_000 })
    return { ...result, scriptLeft: existsSync(script) }
  }

  it.runIf(process.platform !== 'darwin')('moves the bundle into ~/.Trash under a free name, and deletes itself', () => {
    const home = temp()
    const root = join(home, 'Apps 应用')
    const bundle = join(root, 'MossStudio.app')
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    mkdirSync(join(home, '.Trash', 'MossStudio.app'), { recursive: true })
    const result = runHelper(home, bundle)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(bundle)).toBe(false)
    expect(readdirSync(join(home, '.Trash')).sort()).toEqual(['MossStudio 1.app', 'MossStudio.app'])
    expect(result.scriptLeft).toBe(false)
  })

  it('does nothing when the bundle is already gone', () => {
    const home = temp()
    const result = runHelper(home, join(home, 'missing', 'MossStudio.app'))
    expect(result.status).toBe(0)
    expect(existsSync(join(home, '.Trash'))).toBe(false)
  })

  it('waits for the app to exit before moving the bundle', async () => {
    const home = temp()
    const bundle = join(home, 'MossStudio.app')
    mkdirSync(bundle)
    const app = spawn('/bin/sh', ['-c', 'sleep 1'])
    const script = join(temp(), 'trash.sh')
    writeFileSync(script, MAC_TRASH_HELPER, { mode: 0o700 })
    const helper = spawn('/bin/sh', [script, String(app.pid), bundle], {
      env: { ...process.env, HOME: home, PATH: process.env.PATH ?? '' },
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(existsSync(bundle)).toBe(true)
    const code = await new Promise<number | null>((resolve) => helper.once('exit', resolve))
    expect(app.exitCode).toBe(0)
    expect(code).toBe(0)
    expect(existsSync(bundle)).toBe(false)
  })
})

describe('trashBundleAfterExit', () => {
  const temp = useTempDir()
  it('starts the helper detached under /bin/sh with pid and bundle as arguments', async () => {
    const calls: { command: string; args: readonly string[]; detached?: boolean }[] = []
    const pid = await trashBundleAfterExit('/Applications/Moss Studio/MossStudio.app', 4242, {
      tempDir: temp(),
      spawn: (command, args, options) => {
        calls.push({ command, args, detached: options.detached })
        return {
          pid: 77,
          unref: () => undefined,
          once: (event: string, listener: () => void) => {
            if (event === 'spawn') queueMicrotask(listener)
          },
        } as never
      },
    })
    expect(pid).toBe(77)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.command).toBe('/bin/sh')
    expect(calls[0]!.args.slice(1)).toEqual(['4242', '/Applications/Moss Studio/MossStudio.app'])
    expect(calls[0]!.detached).toBe(true)
  })
})
