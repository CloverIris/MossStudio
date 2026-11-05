import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const r = (p: string) => resolve(import.meta.dirname, p)

/**
 * Unit tests run in three projects that mirror the electron-vite build targets:
 *  - main:     Node, with `electron` replaced by test/mocks/electron.ts
 *  - shared:   Node, pure helpers and zod schemas
 *  - renderer: happy-dom, non-UI renderer modules driven through the mock backend
 *  - tools:    Node, the release pipeline scripts (tools/release)
 *
 * src/main/*.test.ts are NOT Vitest files: main/index.ts imports them for the
 * in-Electron `--smoke` run, so they are excluded here.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': r('src/shared'),
      '@main': r('src/main'),
      '@renderer': r('src/renderer/src'),
      '@test': r('test'),
    },
  },
  test: {
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    projects: [
      {
        extends: true,
        resolve: {
          alias: {
            electron: r('test/mocks/electron.ts'),
            'node:original-fs': r('test/mocks/original-fs.ts'),
            'original-fs': r('test/mocks/original-fs.ts'),
          },
        },
        test: {
          name: 'main',
          environment: 'node',
          include: ['test/main/**/*.test.ts'],
          setupFiles: ['test/setup/main.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'shared',
          environment: 'node',
          include: ['test/shared/**/*.test.ts', 'test/mocks/**/*.test.ts'],
        },
      },
      {
        // tools/release (the release pipeline, plain .mjs) checked against the app's own
        // contract schemas and updater code; electron is aliased in case those import it.
        extends: true,
        resolve: {
          alias: {
            electron: r('test/mocks/electron.ts'),
            // update/* does app-folder IO through Electron's asar-unaware original-fs.
            'node:original-fs': r('test/mocks/original-fs.ts'),
            'original-fs': r('test/mocks/original-fs.ts'),
          },
        },
        test: {
          name: 'tools',
          environment: 'node',
          include: ['test/tools/**/*.test.mjs'],
        },
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          environment: 'happy-dom',
          include: ['test/renderer/**/*.test.ts'],
          setupFiles: ['test/setup/renderer.ts'],
        },
      },
    ],
  },
})
