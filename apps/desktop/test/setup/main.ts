import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, vi } from 'vitest'
import { guardedFetch } from '../helpers/network'

// Anything that reaches paths.root() without a per-test override lands in a
// throwaway directory, never the developer's real profile.
const fallbackRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'mossstudio-worker-')))
process.env['MOSSSTUDIO_TEST_USERDATA'] ??= fallbackRoot

beforeEach(() => {
  vi.stubGlobal('fetch', guardedFetch)
})
