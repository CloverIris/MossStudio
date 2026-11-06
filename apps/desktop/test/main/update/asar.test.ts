/**
 * In the packaged main process Electron patches node:fs so every `*.asar` reads as a folder
 * ("Invalid package …/app.asar"). App folders are plain files to the updater, so update/* must do
 * its file IO through original-fs. Here node:fs/promises behaves like the patched one for any
 * path with an .asar part; original-fs (test/mocks/original-fs.ts) stays plain.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { useTempDir } from '@test/helpers/tempDir'
import { fileListOf, makeZip, sha256, thisPlatform } from './helpers'

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const guard = <T extends (...args: never[]) => unknown>(fn: T): T =>
    ((...args: Parameters<T>) => {
      if (args.some((arg) => typeof arg === 'string' && /\.asar(?:[\\/]|$)/.test(arg)))
        return Promise.reject(new Error(`Invalid package ${String(args[0])}`))
      return fn(...args)
    }) as T
  const patched = Object.fromEntries(
    Object.entries(real).map(([name, value]) => [name, typeof value === 'function' ? guard(value as never) : value]),
  )
  return { ...patched, default: patched }
})

const temp = useTempDir('moss-asar-')
const platform = thisPlatform()

describe('app folders with app.asar', () => {
  it('materializes and verifies a package whose resources hold app.asar (full and delta)', async () => {
    const { materialize, verifyTree } = await import('@main/update/materialize')
    const asar = Buffer.concat([Buffer.from([4, 0, 0, 0]), Buffer.from('{"files":{}}'.padEnd(64, ' '))])
    const source = join(temp(), 'src')
    const write = (path: string, data: string | Buffer) => {
      const full = join(source, ...path.split('/'))
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, data)
    }
    write('MossStudio', 'binary')
    write('resources/app.asar', asar)
    write('resources/app.asar.unpacked/native.node', 'native')
    const list = fileListOf(source, '1.1.0', platform)
    const items = list.entries.map((entry) => ({
      name: entry.path,
      data: readFileSync(join(source, ...entry.path.split('/'))),
      mode: entry.type === 'file' ? entry.mode : undefined,
    }))
    const zip = join(temp(), 'full.zip')
    writeFileSync(zip, makeZip(items))
    const root = join(temp(), 'R')
    const out = await materialize({
      kind: 'full',
      zipPath: zip,
      fileList: list,
      partialDir: join(root, 'app-1.1.0.partial'),
      finalDir: join(root, 'app-1.1.0'),
    })
    expect(readFileSync(join(out, 'resources', 'app.asar')).equals(asar)).toBe(true)
    await expect(verifyTree(out, list)).resolves.toBeUndefined()

    // Delta from app-1.1.0 to 1.2.0 that changes app.asar and keeps the unpacked folder.
    const asar2 = Buffer.concat([asar, Buffer.from('v2')])
    write('resources/app.asar', asar2)
    const next = { ...fileListOf(source, '1.2.0', platform) }
    const filesBytes = Buffer.from(JSON.stringify(next))
    const manifest = {
      schema: 1,
      platform,
      from: '1.1.0',
      to: '1.2.0',
      files: { sha256: sha256(filesBytes), size: filesBytes.length },
      changed: ['resources/app.asar'],
      removed: [],
    }
    const delta = join(temp(), 'delta.zip')
    writeFileSync(
      delta,
      makeZip([
        { name: 'delta.json', data: JSON.stringify(manifest) },
        { name: 'files/resources/app.asar', data: asar2 },
      ]),
    )
    const out2 = await materialize({
      kind: 'delta',
      zipPath: delta,
      fileList: next,
      baseDir: out,
      baseVersion: '1.1.0',
      filesSha256: manifest.files.sha256,
      partialDir: join(root, 'app-1.2.0.partial'),
      finalDir: join(root, 'app-1.2.0'),
    })
    expect(readFileSync(join(out2, 'resources', 'app.asar')).equals(asar2)).toBe(true)
    expect(readFileSync(join(out2, 'resources', 'app.asar.unpacked', 'native.node'), 'utf8')).toBe('native')
  })

  it('the patched fs really refuses .asar paths (the failure the updater must avoid)', async () => {
    const promises = await import('node:fs/promises')
    const file = join(temp(), 'x.asar')
    writeFileSync(file, 'x')
    await expect(promises.lstat(file)).rejects.toThrow('Invalid package')
  })

  it('no update module imports node:fs for file IO', () => {
    const dir = join(__dirname, '..', '..', '..', 'src', 'main', 'update')
    // index.ts only checks the launcher and the bundle folder; handoff.ts writes a temp script.
    const allowed = new Set(['index.ts', 'handoff.ts'])
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.ts') && !allowed.has(file))) {
      const source = readFileSync(join(dir, name), 'utf8')
      expect(source, name).not.toMatch(/from 'node:fs(?:\/promises)?'|from 'fs(?:\/promises)?'/)
    }
  })
})
