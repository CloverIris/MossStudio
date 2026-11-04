import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const mainRoot = new URL('../apps/desktop/src/main/', import.meta.url)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { url: 'data:text/javascript,export%20const%20app%20=%20{}', shortCircuit: true }
    }
    if (
      context.parentURL?.endsWith('/lib/engineArchive.ts') &&
      (specifier === './paths' || specifier === './run')
    ) {
      return { url: new URL(`lib/${specifier.slice(2)}.ts`, mainRoot).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { extractArchive } = await import('../apps/desktop/src/main/lib/engineArchive.ts')

// 内含 mossinfer-test/bin/moss-server.exe，文件内容为 engine。
const zipFixture = 'UEsDBBQAAAAIAGCRZF2NGqjoCAAAAAYAAAAiAAAAbW9zc2luZmVyLXRlc3QvYmluL21vc3Mtc2VydmVyLmV4ZUvNS8/MSwUAUEsBAhQAFAAAAAgAYJFkXY0aqOgIAAAABgAAACIAAAAAAAAAAAAAAAAAAAAAAG1vc3NpbmZlci10ZXN0L2Jpbi9tb3NzLXNlcnZlci5leGVQSwUGAAAAAAEAAQBQAAAASAAAAAAA'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'moss-engine-archive-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const archive = join(root, 'stable-v2.1.2-cu13-system-cuda.download')
  const dest = join(root, 'extracted')
  return { archive, dest }
}

test('Windows ZIP 使用 download 临时文件名时仍按 ZIP 解压', async (t) => {
  const { archive, dest } = await fixture(t)
  await writeFile(archive, Buffer.from(zipFixture, 'base64'))
  await extractArchive(archive, dest, 'zip')
  assert.equal(
    await readFile(join(dest, 'mossinfer-test', 'bin', 'moss-server.exe'), 'utf8'),
    'engine',
  )
})

test('显式 ZIP 格式不会回退到 tar', async (t) => {
  const { archive, dest } = await fixture(t)
  await writeFile(archive, 'not a zip')
  await assert.rejects(extractArchive(archive, dest, 'zip'), /无法打开 ZIP 引擎包/)
})
