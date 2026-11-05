import { afterEach, beforeEach } from 'vitest'

const original = process.platform

/** Set `process.platform` for one test. */
export function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

/**
 * Run every test in the file as if on `platform`, restoring the real value
 * afterwards. Only for code that reads `process.platform` at call time; the
 * host's `node:path` stays native, so build expected paths with `join`.
 */
export function usePlatform(platform: NodeJS.Platform): void {
  beforeEach(() => setPlatform(platform))
  afterEach(() => setPlatform(original))
}
