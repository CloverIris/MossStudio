#!/usr/bin/env node
// `pnpm test:install`: the whole install → update → rollback → uninstall test on this machine
// (Linux; Windows works too), the same steps build.yml runs per OS:
//   ephemeral test key → test build (`pnpm build` with the key and the local feed URL) →
//   launcher build → prepare.mjs (X, X+1, X+2 + feeds) → run.mjs (under xvfb-run when there
//   is no display).
// Options are passed to run.mjs (e.g. --report <dir>). MOSS_IT_SKIP_BUILD=1 reuses apps/desktop/out
// and launcher/dist from an earlier run made with the same key file (dist/it/test-key.txt).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP_DIR, hostPlatform, main, REPO_ROOT, run } from '../lib/cli.mjs'
import { generateKeyPair, keyIdFor, parsePrivateKey, publicKeyBase64 } from '../lib/sign.mjs'
import { itFeedUrl } from './server.mjs'

main(async () => {
  const platform = hostPlatform()
  const itDir = join(REPO_ROOT, 'dist', 'it')
  mkdirSync(itDir, { recursive: true })
  const keyFile = join(itDir, 'test-key.txt')
  const reuse = process.env.MOSS_IT_SKIP_BUILD === '1' && existsSync(keyFile)
  if (!reuse) writeFileSync(keyFile, generateKeyPair().privateKeyBase64, { mode: 0o600 })
  const publicKey = publicKeyBase64(parsePrivateKey(readFileSync(keyFile, 'utf8')))
  const testKeys = JSON.stringify([{ id: keyIdFor(publicKey), publicKey }])
  const execPath = process.env.npm_execpath
  const pnpm = execPath && /\.(c?js|mjs)$/i.test(execPath) ? [process.execPath, [execPath]] : ['pnpm', []]

  if (!reuse) {
    run(pnpm[0], [...pnpm[1], 'build'], { cwd: REPO_ROOT, env: { ...process.env, MOSS_UPDATE_TEST_KEYS: testKeys, MOSS_UPDATE_FEED_URL: itFeedUrl() } })
    run('bash', [join(REPO_ROOT, 'launcher', 'build.sh')], { cwd: join(REPO_ROOT, 'launcher') })
  } else if (!existsSync(join(DESKTOP_DIR, 'out', 'main', 'index.js'))) {
    throw new Error('MOSS_IT_SKIP_BUILD=1 but apps/desktop/out is missing')
  }
  run(process.execPath, ['--no-warnings', join(REPO_ROOT, 'tools', 'release', 'integration', 'prepare.mjs'), '--platform', platform, '--key-file', keyFile])
  const runArgs = [join(REPO_ROOT, 'tools', 'release', 'integration', 'run.mjs'), '--platform', platform, ...process.argv.slice(2)]
  const xvfb = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? ['/usr/bin/xvfb-run', '/bin/xvfb-run'].find(existsSync) : undefined
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !xvfb) throw new Error('no display and no xvfb-run: install xvfb')
  if (xvfb) run(xvfb, ['-a', '-s', '-screen 0 1600x1000x24', process.execPath, ...runArgs])
  else run(process.execPath, runArgs)
})
