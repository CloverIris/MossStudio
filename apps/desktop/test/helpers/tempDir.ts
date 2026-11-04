import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'

/** Fresh directory per test, removed afterwards. Returns a getter for the path. */
export function useTempDir(prefix = 'mossstudio-test-'): () => string {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), prefix)) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
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
