import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const r = (p: string): string => resolve(import.meta.dirname, '..', p)

/**
 * E2E: specs run in Node and drive the E2E app in a real Electron window via
 * playwright-core's `_electron`. One Electron per spec file, files run one at
 * a time (they share the X display and screenshot folder).
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': r('src/shared'), '@renderer': r('src/renderer/src'), '@test': r('test') },
  },
  test: {
    name: 'e2e',
    root: import.meta.dirname,
    include: ['specs/**/*.e2e.ts'],
    environment: 'node',
    globalSetup: ['./globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    reporters: ['default'],
  },
})
