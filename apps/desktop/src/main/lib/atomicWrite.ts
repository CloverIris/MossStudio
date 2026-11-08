import { rename, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

/** What Windows answers while another program (Defender, the search indexer, a backup tool) briefly holds a file. */
const LOCKED_CODES = ['EBUSY', 'EPERM', 'EACCES']

export function isLockedError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : ''
  return LOCKED_CODES.includes(code)
}

export interface RenameRetryOptions {
  /** The rename to run (tests and the engine store pass their own). */
  rename?: (from: string, to: string) => Promise<void>
  attempts?: number
  delayMs?: number
}

/** Rename, retried while the file is briefly locked; any other error, or the last attempt's, is thrown. */
export async function renameWithRetry(from: string, to: string, options: RenameRetryOptions = {}): Promise<void> {
  const doRename = options.rename ?? rename
  const attempts = options.attempts ?? 5
  const delayMs = options.delayMs ?? 200
  for (let attempt = 1; ; attempt += 1) {
    try {
      await doRename(from, to)
      return
    } catch (error) {
      if (!isLockedError(error) || attempt >= attempts) throw error
      if (delayMs > 0) await delay(delayMs)
    }
  }
}

export interface AtomicWriteOptions extends RenameRetryOptions {
  writeFile?: (path: string, contents: string) => Promise<void>
  rm?: (path: string) => Promise<void>
}

/**
 * Writes `contents` to `file` without blocking the main thread: a temp file next to it, then a rename
 * (retried while locked), so readers see the old file or the new one, never half of one. The temp file
 * is removed when the write fails. No fsync: a crash cannot tear the file, a power loss can.
 */
export async function writeFileAtomic(file: string, contents: string, options: AtomicWriteOptions = {}): Promise<void> {
  const temporary = `${file}.tmp`
  const write = options.writeFile ?? ((path: string, text: string) => writeFile(path, text, 'utf8'))
  const remove = options.rm ?? ((path: string) => rm(path, { force: true }))
  try {
    await write(temporary, contents)
    await renameWithRetry(temporary, file, options)
  } catch (error) {
    // Best effort: a temp file that cannot be removed is overwritten by the next write.
    await remove(temporary).catch(() => undefined)
    throw error
  }
}
