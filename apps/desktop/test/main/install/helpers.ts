import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach } from 'vitest'

/**
 * A fresh folder per test OUTSIDE the OS temp folder: the install rules refuse temp
 * (and macOS keeps it under /private/var, a system tree), so flows that validate their
 * target need a normal folder. Lives under node_modules/.cache (ignored), removed after.
 */
export function useWorkDir(prefix = 'install-'): () => string {
  let dir = ''
  beforeEach(() => {
    const base = resolve(__dirname, '..', '..', '..', 'node_modules', '.cache', 'mossstudio-install-tests')
    mkdirSync(base, { recursive: true })
    dir = realpathSync.native(mkdtempSync(join(base, prefix)))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  })
  return () => dir
}
