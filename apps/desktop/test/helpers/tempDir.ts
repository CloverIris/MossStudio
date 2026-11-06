import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'

/**
 * Fresh directory per test, removed afterwards. Returns a getter for the path.
 *
 * The path is canonical (realpath): os.tmpdir() can be an 8.3 short name on
 * Windows (C:\\Users\\RUNNER~1) or a symlink on macOS (/var -> /private/var),
 * while app code that calls realpath reports the long form.
 */
export function useTempDir(prefix = 'mossstudio-test-'): () => string {
  let dir = ''
  beforeEach(() => { dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix))) })
  // Retries: code under test may still be finishing a fire-and-forget write (the supervisor's
  // job list, a log line) into the folder while it is removed (ENOTEMPTY, EBUSY).
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })
  return () => dir
}

/**
 * Point main's data root (paths.root(), via MOSSSTUDIO_DATA) and the fake
 * Electron userData at a fresh temp directory for every test.
 */
export function useTempDataRoot(): () => string {
  const dir = useTempDir('mossstudio-data-')
  let previous: Record<string, string | undefined> = {}
  beforeEach(() => {
    previous = { MOSSSTUDIO_DATA: process.env['MOSSSTUDIO_DATA'], MOSSSTUDIO_TEST_USERDATA: process.env['MOSSSTUDIO_TEST_USERDATA'] }
    process.env['MOSSSTUDIO_DATA'] = dir()
    process.env['MOSSSTUDIO_TEST_USERDATA'] = dir()
  })
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  return dir
}
