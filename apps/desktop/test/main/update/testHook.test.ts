import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isUpdateTestBuild } from '@main/update/keys'
import {
  loadTestHook,
  parseTestHook,
  readyToRestart,
  shouldCrash,
  TEST_HOOK_FILE,
  TEST_STATUS_FILE,
  writeTestStatus,
} from '@main/update/testHook'
import { updaterStateFixture } from '@test/mocks/backend/fixtures'
import { useTempDir } from '@test/helpers/tempDir'

const temp = useTempDir('moss-hook-')

function writeHook(value: unknown): void {
  writeFileSync(join(temp(), TEST_HOOK_FILE), typeof value === 'string' ? value : JSON.stringify(value))
}

describe('CI update test hook', () => {
  it('is never active in a build without test keys, even with the file present (release builds)', () => {
    writeHook({ pollMs: 2000, crashVersions: ['1.0.3'] })
    // Unit tests, like release builds, have no __MOSS_UPDATE_TEST_KEYS__ value.
    expect(isUpdateTestBuild()).toBe(false)
    expect(loadTestHook(temp(), isUpdateTestBuild())).toBeNull()
    expect(loadTestHook(temp(), false)).toBeNull()
  })

  it('reads moss-test.json in a test build', () => {
    writeHook({ pollMs: 2000, crashVersions: ['1.0.6'] })
    expect(loadTestHook(temp(), true)).toEqual({ pollMs: 2000, crashVersions: ['1.0.6'] })
  })

  it('tolerates a missing or broken file and odd values', () => {
    expect(loadTestHook(temp(), true)).toBeNull()
    writeHook('{ nope')
    expect(loadTestHook(temp(), true)).toBeNull()
    expect(parseTestHook('﻿{"pollMs": 5, "crashVersions": ["1.0.6", 7]}')).toEqual({ pollMs: 200, crashVersions: ['1.0.6'] })
    expect(parseTestHook('{"pollMs": -1}')).toEqual({ pollMs: null, crashVersions: [] })
    expect(parseTestHook('[]')).toBeNull()
  })

  it('crashes only the listed versions', () => {
    const hook = { pollMs: null, crashVersions: ['1.0.6'] }
    expect(shouldCrash(hook, '1.0.6')).toBe(true)
    expect(shouldCrash(hook, '1.0.5')).toBe(false)
    expect(shouldCrash(null, '1.0.6')).toBe(false)
  })

  it('restarts only once pending is ready and health is confirmed', () => {
    expect(readyToRestart({ phase: 'ready', pending: '1.0.5' }, true)).toBe(true)
    expect(readyToRestart({ phase: 'ready', pending: '1.0.5' }, false)).toBe(false)
    expect(readyToRestart({ phase: 'downloading', pending: null }, true)).toBe(false)
  })

  it('writes the status file for the CI log', async () => {
    await writeTestStatus(temp(), updaterStateFixture({ phase: 'error', error: 'boom' }))
    expect(JSON.parse(readFileSync(join(temp(), TEST_STATUS_FILE), 'utf8'))).toMatchObject({ phase: 'error', error: 'boom' })
  })
})
