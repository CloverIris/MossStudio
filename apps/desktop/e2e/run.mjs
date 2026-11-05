#!/usr/bin/env node
// Runs the E2E suite: builds the E2E renderer (in Vitest's globalSetup) and
// drives it in Electron. On Linux it runs under a private X server
// (xvfb-run) so windows never appear on the desktop; E2E_HEADED=1 opts out.
//
//   node e2e/run.mjs [vitest args, e.g. specs/studio.e2e.ts -t "seed"]
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vitest = resolve(desktop, 'node_modules/.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest')
const args = ['run', '--config', 'e2e/vitest.config.mts', ...process.argv.slice(2)]
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const xvfb = process.platform === 'linux' && !process.env.E2E_HEADED && ['/usr/bin/xvfb-run', '/bin/xvfb-run'].find(existsSync)
const [command, commandArgs] = xvfb
  // 1920×1200 so the 1600×1000 window fits without the screen clamping it.
  ? [xvfb, ['-a', '-s', '-screen 0 1920x1200x24', vitest, ...args]]
  : [vitest, args]
const result = spawnSync(command, commandArgs, { cwd: desktop, env, stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
