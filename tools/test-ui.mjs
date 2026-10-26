import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)
const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)
const root = fileURLToPath(new URL('../', import.meta.url))
const output = mkdtempSync(join(tmpdir(), 'clover-ui-'))
const screenshots = process.argv.find((arg) => arg.startsWith('--screenshots='))?.slice('--screenshots='.length)
const dpiAudit = process.argv.includes('--dpi')

try {
  await build({
    configFile: false,
    root: resolve(root, 'tools/ui-fixture'),
    base: './',
    define: { 'process.env.NODE_ENV': JSON.stringify(process.argv.includes('--development') ? 'development' : 'production') },
    resolve: {
      alias: {
        '@shared': resolve(root, 'apps/desktop/src/shared'),
        'react': dirname(require.resolve('react/package.json')),
        'react-dom': dirname(require.resolve('react-dom/package.json')),
        'react-router-dom': dirname(require.resolve('react-router-dom/package.json')),
      },
    },
    plugins: [react(), tailwindcss()],
    build: { outDir: output, emptyOutDir: true },
  })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const scale of dpiAudit ? ['native', 1, 1.25, 1.5, 1.75, 2] : process.argv.includes('--scaled') ? [1, 1.5, 2] : [1]) {
    const result = spawnSync(require('electron'), [resolve(root, dpiAudit ? 'tools/ui-dpi-check-electron.cjs' : 'tools/ui-check-electron.cjs'), output], {
      env: {
        ...env,
        CLOVER_UI_SCALE: String(scale),
        ...(dpiAudit ? { CLOVER_UI_SCREENSHOTS: resolve(screenshots ?? 'docs/assets/ui-dpi-review') } : {}),
        CLOVER_UI_STUDIO_ONLY: process.argv.includes('--studio') ? '1' : '0',
        CLOVER_UI_UX_ONLY: process.argv.includes('--ux') ? '1' : '0',
        CLOVER_UI_SSH_ONLY: process.argv.includes('--ssh') ? '1' : '0',
        CLOVER_UI_OOBE_ONLY: process.argv.includes('--oobe') ? '1' : '0',
        ...(screenshots ? { CLOVER_UI_SCREENSHOTS: resolve(screenshots) } : {}),
      },
      stdio: 'inherit',
      timeout: 60000,
      windowsHide: true,
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1
      break
    }
  }
  if (dpiAudit && !process.exitCode) {
    const { writeDpiReport } = await import('./ui-dpi-report.mjs')
    writeDpiReport(resolve(screenshots ?? 'docs/assets/ui-dpi-review'))
  }
} finally {
  rmSync(output, { recursive: true, force: true })
}
