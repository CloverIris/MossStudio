import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAC_SWAP_HELPER, macSwapArgs, type MacSwapArgs } from './macHelper'

/** The part of a ChildProcess the handoff needs. */
export interface SpawnedChild {
  unref(): void
  once(event: 'spawn', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedChild

/**
 * Launcher arguments for "the app is quitting; wait for <pid> and every process under R, apply
 * pending, start current with --moss-launched".
 */
export function launcherRestartArgs(pid: number): string[] {
  return [`--restart=${pid}`]
}

const DETACHED: SpawnOptions = { detached: true, stdio: 'ignore', windowsHide: true }

/** Resolve once the OS really started the child; reject with the spawn error (missing file, EACCES…). */
function started(child: SpawnedChild): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', (error) => reject(error))
  })
}

/** Windows/Linux: hand the restart to the launcher (argument array, no shell). Resolves once it runs. */
export async function spawnLauncherRestart(launcher: string, pid: number, spawn: SpawnFn = nodeSpawn): Promise<void> {
  const child = spawn(launcher, launcherRestartArgs(pid), { ...DETACHED, env: process.env })
  try {
    await started(child)
  } catch (error) {
    throw new Error(`无法启动 MossStudio 启动器：${error instanceof Error ? error.message : String(error)}`)
  }
  child.unref()
}

/**
 * macOS: write the static swap helper to a private temp file and start it detached under /bin/sh
 * with every value as an argument. Resolves (with the script path) once the helper runs; the
 * script deletes itself when it is done.
 */
export async function spawnMacSwap(args: MacSwapArgs, deps: { spawn?: SpawnFn; tempDir?: string } = {}): Promise<string> {
  const file = join(deps.tempDir ?? tmpdir(), `mossstudio-swap-${randomBytes(6).toString('hex')}.sh`)
  await writeFile(file, MAC_SWAP_HELPER, { encoding: 'utf8', mode: 0o700, flag: 'wx' })
  await chmod(file, 0o700)
  const child = (deps.spawn ?? nodeSpawn)('/bin/sh', [file, ...macSwapArgs(args)], DETACHED)
  try {
    await started(child)
  } catch (error) {
    await rm(file, { force: true }).catch(() => undefined)
    throw new Error(`无法启动更新助手：${error instanceof Error ? error.message : String(error)}`)
  }
  child.unref()
  return file
}
