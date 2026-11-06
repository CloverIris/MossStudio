#!/usr/bin/env node
// Runs the in-Electron checks built into the main process (src/main/*.test.ts,
// selected with --smoke / --scenario=<name>) against the built app in out/.
// Build first: pnpm --filter @clover/desktop build.
//
//   node e2e/run-scenarios.mjs [smoke project-canvases model-management studio-canvas-ui]
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')
const ALL = ['smoke', 'project-canvases', 'model-management', 'studio-canvas-ui']
const names = process.argv.slice(2).length ? process.argv.slice(2) : ALL
if (!existsSync(resolve(desktop, 'out/main/index.js'))) {
  console.error('out/main/index.js is missing; run `pnpm --filter @clover/desktop build` first')
  process.exit(1)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.WAYLAND_DISPLAY
const xvfb = process.platform === 'linux' && !process.env.E2E_HEADED && ['/usr/bin/xvfb-run', '/bin/xvfb-run'].find(existsSync)
let failed = 0
for (const name of names) {
  // --no-sandbox on the command line: appending it at runtime does not reach
  // renderer processes, which then crash on hosts without a usable sandbox.
  const args = ['.', '--no-sandbox', name === 'smoke' ? '--smoke' : `--scenario=${name}`]
  if (process.platform === 'linux') args.push('--ozone-platform=x11')
  const [command, commandArgs] = xvfb ? [xvfb, ['-a', '-s', '-screen 0 1920x1200x24', electron, ...args]] : [electron, args]
  const started = Date.now()
  const result = spawnSync(command, commandArgs, { cwd: desktop, env, encoding: 'utf8', timeout: 180_000 })
  const ok = result.status === 0
  if (!ok) failed += 1
  console.log(`${ok ? '✓' : '✗'} ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  if (!ok)
    console.log(
      `${result.stdout}\n${result.stderr}`
        .split('\n')
        .filter((line) => line && !/dbus|Fontconfig|Security Warning|electronjs\.org\/docs/.test(line))
        .slice(-40)
        .join('\n'),
    )
}
process.exit(failed ? 1 : 0)
