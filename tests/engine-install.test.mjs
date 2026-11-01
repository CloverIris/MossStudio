import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  cleanupPromotedInstall,
  isManagedEngineDirectory,
  promoteInstall,
  recoverEngineInstall,
} from '../apps/desktop/src/main/lib/engineStore.ts'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'moss-engine-store-'))
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  })
  const stamp = 'stable-v2.1.1-cu13'
  const stagingDir = join(root, '.staging', `${stamp}-new`)
  await mkdir(join(stagingDir, 'bin'), { recursive: true })
  await writeFile(join(stagingDir, 'bin', 'moss-server'), 'new')
  return { root, stamp, stagingDir, installDir: join(root, stamp) }
}

async function addOldInstall(installDir) {
  await mkdir(join(installDir, 'bin'), { recursive: true })
  await writeFile(join(installDir, 'bin', 'moss-server'), 'old')
}

test('无旧目录时直接晋升', async (t) => {
  const { root, stamp, stagingDir, installDir } = await fixture(t)
  const result = await promoteInstall({ root, stagingDir, stamp, currentServerPath: null })
  assert.equal(result.installDir, installDir)
  assert.equal(await readFile(join(installDir, 'bin', 'moss-server'), 'utf8'), 'new')
  assert.equal(existsSync(stagingDir), false)
  assert.equal(existsSync(join(root, '.pending.json')), false)
})

test('替换非 current 版本时旧目录进入 trash，设置更新后再清理', async (t) => {
  const { root, stamp, stagingDir, installDir } = await fixture(t)
  await addOldInstall(installDir)
  const result = await promoteInstall({ root, stagingDir, stamp, currentServerPath: null })
  assert.equal(await readFile(join(result.trashDir, 'bin', 'moss-server'), 'utf8'), 'old')
  assert.equal(await readFile(join(installDir, 'bin', 'moss-server'), 'utf8'), 'new')
  await cleanupPromotedInstall(result)
  assert.equal(existsSync(result.trashDir), false)
})

test('替换 current 失败时自动从 backup 回滚', async (t) => {
  const { root, stamp, stagingDir, installDir } = await fixture(t)
  await addOldInstall(installDir)
  let shutdownCalled = false
  await assert.rejects(
    promoteInstall({
      root,
      stagingDir,
      stamp,
      currentServerPath: join(installDir, 'bin', 'moss-server'),
      beforeReplace: async () => { shutdownCalled = true },
    }, {
      retryDelayMs: 0,
      ops: {
        rename: async (from, to) => {
          if (from === stagingDir && to === installDir) {
            const error = new Error('locked')
            error.code = 'EPERM'
            throw error
          }
          const { rename } = await import('node:fs/promises')
          await rename(from, to)
        },
      },
    }),
    /无法替换旧目录/,
  )
  assert.equal(shutdownCalled, true)
  assert.equal(await readFile(join(installDir, 'bin', 'moss-server'), 'utf8'), 'old')
  assert.equal(existsSync(stagingDir), false)
  assert.equal(existsSync(join(root, '.pending.json')), false)
})

test('旧目录连续 EPERM 时 staging 被清理且 installDir 原样保留', async (t) => {
  const { root, stamp, stagingDir, installDir } = await fixture(t)
  await addOldInstall(installDir)
  let attempts = 0
  await assert.rejects(
    promoteInstall({
      root,
      stagingDir,
      stamp,
      currentServerPath: join(installDir, 'bin', 'moss-server'),
    }, {
      retryDelayMs: 0,
      ops: {
        rename: async (from, to) => {
          if (from === installDir) {
            attempts += 1
            const error = new Error('in use')
            error.code = 'EPERM'
            throw error
          }
          const { rename } = await import('node:fs/promises')
          await rename(from, to)
        },
      },
    }),
    /引擎正在使用/,
  )
  assert.equal(attempts, 5)
  assert.equal(await readFile(join(installDir, 'bin', 'moss-server'), 'utf8'), 'old')
  assert.equal(existsSync(stagingDir), false)
})

test('启动恢复发现 installDir 缺失和 backup 时还原旧引擎', async (t) => {
  const { root, stamp, stagingDir, installDir } = await fixture(t)
  const backupDir = join(root, '.backup', `${stamp}-old`)
  await addOldInstall(backupDir)
  await writeFile(join(root, '.pending.json'), JSON.stringify({
    schemaVersion: 1,
    stamp,
    installDir,
    stagingDir,
    previousDir: backupDir,
  }))
  const result = await recoverEngineInstall(root, { retryDelayMs: 0 })
  assert.deepEqual(result.restored, [installDir])
  assert.equal(await readFile(join(installDir, 'bin', 'moss-server'), 'utf8'), 'old')
  assert.equal(existsSync(join(root, '.pending.json')), false)
  assert.equal(existsSync(stagingDir), false)
})

test('点号开头的 staging、backup、trash 不作为版本目录列出', async (t) => {
  const { root } = await fixture(t)
  await mkdir(join(root, '.trash'), { recursive: true })
  await mkdir(join(root, '.backup'), { recursive: true })
  await mkdir(join(root, 'stable-v2.1.1-cu13'), { recursive: true })
  const visible = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && isManagedEngineDirectory(entry.name))
    .map((entry) => entry.name)
  assert.deepEqual(visible, ['stable-v2.1.1-cu13'])
})
