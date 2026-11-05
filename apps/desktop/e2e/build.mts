/**
 * Builds the E2E renderer (e2e/app: the real App over the mock backend) with
 * the same aliases and plugins as the electron-vite renderer build.
 */
import { resolve } from 'node:path'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const r = (p: string): string => resolve(import.meta.dirname, '..', p)

export async function buildE2eApp(outDir: string): Promise<string> {
  await build({
    configFile: false,
    logLevel: 'warn',
    root: r('e2e/app'),
    base: './',
    // The app icon and other static files, served next to index.html as in the real build.
    publicDir: r('src/renderer/public'),
    mode: 'production',
    resolve: {
      alias: { '@renderer': r('src/renderer/src'), '@shared': r('src/shared') },
    },
    plugins: [react(), tailwindcss()],
    build: { outDir, emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 10_000, reportCompressedSize: false },
  })
  return outDir
}
