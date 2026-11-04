import { mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  importModelFolder,
  readImportedModels,
  registerScannedModels,
  removeImportedModel,
  verifyImportedModelFile,
} from '@main/services/modelImports'
import { useTempDir } from '@test/helpers/tempDir'

const tempDir = useTempDir('mossstudio-model-imports-')

async function put(path: string, content: string | Buffer): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  return path
}
const indexFile = (): string => join(tempDir(), 'imports', 'index.json')

describe('importModelFolder', () => {
  it('imports recognized files, infers ComfyUI roles, and deduplicates by SHA256', async () => {
    const models = join(tempDir(), 'ComfyUI', 'models')
    await put(join(models, 'diffusion_models', 'model.safetensors'), 'same-content')
    await put(join(models, 'vae', 'duplicate.safetensors'), 'same-content')
    await put(join(models, 'vae', 'vae.safetensors'), 'vae-content')
    await put(join(models, 'readme.txt'), 'ignored')

    const result = await importModelFolder(models, indexFile())
    const records = await readImportedModels(indexFile())

    expect(result).toEqual({ added: 2, duplicates: 1 })
    expect(records).toHaveLength(2)
    expect(records.find((model) => model.name === 'model.safetensors')?.role).toBe('dit')
    expect(records.find((model) => model.name === 'vae.safetensors')?.role).toBe('vae')
    expect(await verifyImportedModelFile(records[0]!, records[0]!.sha256!, records[0]!.size)).toBe(true)
    expect(records[0]!.id).toBe(`local-file-${records[0]!.sha256!.slice(0, 20)}`)
  })

  it('infers every directory role and falls back to full', async () => {
    const models = join(tempDir(), 'm')
    await put(join(models, 'unet', 'a.safetensors'), 'a')
    await put(join(models, 'checkpoints', 'b.ckpt'), 'b')
    await put(join(models, 'text_encoders', 'c.safetensors'), 'c')
    await put(join(models, 'clip', 'd.bin'), 'd')
    await put(join(models, 'VAES', 'e.pt'), 'e')
    await put(join(models, 'misc', 'f.gguf'), 'f')
    await importModelFolder(models, indexFile())
    const roles = Object.fromEntries((await readImportedModels(indexFile())).map((m) => [m.name, m.role]))
    expect(roles).toEqual({
      'a.safetensors': 'dit',
      'b.ckpt': 'dit',
      'c.safetensors': 'text_encoder',
      'd.bin': 'text_encoder',
      'e.pt': 'vae',
      'f.gguf': 'full',
    })
  })

  it('skips hidden, tooling and output directories and empty files', async () => {
    const models = join(tempDir(), 'm')
    await put(join(models, '.git', 'a.safetensors'), 'a')
    await put(join(models, 'node_modules', 'b.safetensors'), 'b')
    await put(join(models, 'output', 'c.safetensors'), 'c')
    await put(join(models, 'Cache', 'd.safetensors'), 'd')
    await put(join(models, 'empty.safetensors'), '')
    await put(join(models, 'kept.safetensors'), 'kept')
    expect(await importModelFolder(models, indexFile())).toEqual({ added: 1, duplicates: 0 })
    expect((await readImportedModels(indexFile())).map((m) => m.name)).toEqual(['kept.safetensors'])
  })

  it('reimport skips existing content and removing an import never deletes the source file', async () => {
    const models = join(tempDir(), 'models')
    const source = await put(join(models, 'checkpoint.safetensors'), 'checkpoint')
    await importModelFolder(models, indexFile())

    expect(await importModelFolder(models, indexFile())).toEqual({ added: 0, duplicates: 1 })
    const [record] = await readImportedModels(indexFile())
    await removeImportedModel(indexFile(), record!.id)

    expect(await readImportedModels(indexFile())).toEqual([])
    expect(await readFile(source, 'utf8')).toBe('checkpoint')
  })

  it('a record whose original file vanished is replaced by the new location', async () => {
    const first = join(tempDir(), 'first')
    const second = join(tempDir(), 'second')
    await put(join(first, 'w.safetensors'), 'weights')
    await put(join(second, 'w.safetensors'), 'weights')
    await importModelFolder(first, indexFile())
    await rm(first, { recursive: true })
    expect(await importModelFolder(second, indexFile())).toEqual({ added: 1, duplicates: 0 })
    const records = await readImportedModels(indexFile())
    expect(records).toHaveLength(1)
    expect(records[0]!.path).toBe(join(second, 'w.safetensors'))
  })

  it('leaves no temporary index files behind', async () => {
    const models = join(tempDir(), 'models')
    await put(join(models, 'a.safetensors'), 'a')
    await importModelFolder(models, indexFile())
    expect(await readdir(join(tempDir(), 'imports'))).toEqual(['index.json'])
    expect(JSON.parse(await readFile(indexFile(), 'utf8')).schema_version).toBe(2)
  })

  it('rejects a directory without supported model files', async () => {
    await expect(importModelFolder(tempDir(), indexFile())).rejects.toThrow(/没有可导入的模型文件/)
  })

  it('rejects a directory whose only model files are empty', async () => {
    await put(join(tempDir(), 'm', 'empty.safetensors'), '')
    await expect(importModelFolder(join(tempDir(), 'm'), indexFile())).rejects.toThrow(/非空模型文件/)
  })

  it('rejects a file path instead of a folder', async () => {
    const path = await put(join(tempDir(), 'a.safetensors'), 'a')
    await expect(importModelFolder(path, indexFile())).rejects.toThrow('请选择模型文件夹')
  })
})

describe('readImportedModels', () => {
  it('returns an empty list when the index does not exist', async () => {
    expect(await readImportedModels(join(tempDir(), 'none.json'))).toEqual([])
  })

  it.each([
    ['an unknown schema', { schema_version: 3, models: [] }],
    ['a non-array model list', { schema_version: 2, models: {} }],
    ['a record with a bad hash', { schema_version: 2, models: [{ id: 'a', name: 'a', path: '/a', relativePath: 'a', sha256: 'zz', size: 1, mtimeMs: 1, role: 'dit', importedAt: 'x' }] }],
    ['a record with zero size', { schema_version: 2, models: [{ id: 'a', name: 'a', path: '/a', relativePath: 'a', size: 0, mtimeMs: 1, role: 'dit', importedAt: 'x' }] }],
    ['a record with an unknown role', { schema_version: 1, models: [{ id: 'a', name: 'a', path: '/a', relativePath: 'a', size: 1, mtimeMs: 1, role: 'lora', importedAt: 'x' }] }],
    ['a record with an unknown layout', { schema_version: 2, models: [{ id: 'a', name: 'a', path: '/a', relativePath: 'a', size: 1, mtimeMs: 1, role: 'dit', layout: 'x', importedAt: 'x' }] }],
  ])('rejects %s', async (_label, index) => {
    await put(indexFile(), JSON.stringify(index))
    await expect(readImportedModels(indexFile())).rejects.toThrow('本地模型导入记录无效')
  })

  it('accepts schema 1 records without a hash', async () => {
    const record = { id: 'a', name: 'a', path: '/a', relativePath: 'a', size: 1, mtimeMs: 1, role: 'dit', importedAt: 'x' }
    await put(indexFile(), JSON.stringify({ schema_version: 1, models: [record] }))
    expect(await readImportedModels(indexFile())).toEqual([record])
  })

  it('propagates malformed JSON', async () => {
    await put(indexFile(), '{')
    await expect(readImportedModels(indexFile())).rejects.toThrow(SyntaxError)
  })
})

describe('removeImportedModel', () => {
  it('rejects an unknown id', async () => {
    await expect(removeImportedModel(indexFile(), 'nope')).rejects.toThrow('本地导入模型记录不存在')
  })
})

describe('registerScannedModels', () => {
  it('registers files in place without hashing and updates on re-registration', async () => {
    const dit = await put(join(tempDir(), 'c', 'diffusion_models', 'dit.safetensors'), 'dit-weights')
    const result = await registerScannedModels(indexFile(), [
      { path: dit, role: 'dit', layout: 'comfyui-single-file', relativePath: 'diffusion_models/dit.safetensors' },
    ])
    expect(result).toEqual({ added: 1, updated: 0, missing: [] })
    const [record] = await readImportedModels(indexFile())
    expect(record).toMatchObject({
      name: 'dit.safetensors',
      path: dit,
      relativePath: 'diffusion_models/dit.safetensors',
      size: 11,
      role: 'dit',
      layout: 'comfyui-single-file',
    })
    expect(record!.sha256).toBeUndefined()
    expect(record!.id).toMatch(/^local-scan-[a-f0-9]{20}$/)

    await writeFile(dit, 'dit-weights-v2')
    const again = await registerScannedModels(indexFile(), [{ path: dit, role: 'full', name: 'renamed' }])
    expect(again).toEqual({ added: 0, updated: 1, missing: [] })
    const [updated] = await readImportedModels(indexFile())
    expect(updated).toMatchObject({ id: record!.id, importedAt: record!.importedAt, role: 'full', name: 'renamed', size: 14, layout: 'comfyui-single-file' })
  })

  it('reports missing, empty and directory paths and does not write an index for nothing', async () => {
    const empty = await put(join(tempDir(), 'empty.safetensors'), '')
    const result = await registerScannedModels(indexFile(), [
      { path: join(tempDir(), 'missing.safetensors'), role: 'vae' },
      { path: empty, role: 'vae' },
      { path: tempDir(), role: 'vae' },
    ])
    expect(result.added + result.updated).toBe(0)
    expect(result.missing).toHaveLength(3)
    await expect(readFile(indexFile())).rejects.toThrow()
  })

  it('keeps a hash learned by a full import when the file is re-registered by a scan', async () => {
    const models = join(tempDir(), 'models')
    const file = await put(join(models, 'vae', 'v.safetensors'), 'vae')
    await importModelFolder(models, indexFile())
    const [imported] = await readImportedModels(indexFile())
    await registerScannedModels(indexFile(), [{ path: file, role: 'vae' }])
    const [after] = await readImportedModels(indexFile())
    expect(after!.id).toBe(imported!.id)
    expect(after!.sha256).toBe(imported!.sha256)
  })
})

describe('verifyImportedModelFile', () => {
  it('fails for a scanned record, a hash/size mismatch, a vanished file or changed content', async () => {
    const models = join(tempDir(), 'models')
    const file = await put(join(models, 'w.safetensors'), 'weights')
    await importModelFolder(models, indexFile())
    const [record] = await readImportedModels(indexFile())
    const { sha256, size } = record as { sha256: string; size: number }
    expect(await verifyImportedModelFile({ ...record!, sha256: undefined }, sha256, size)).toBe(false)
    expect(await verifyImportedModelFile(record!, 'f'.repeat(64), size)).toBe(false)
    expect(await verifyImportedModelFile(record!, sha256, size + 1)).toBe(false)
    await writeFile(file, 'WEIGHTS')
    await utimes(file, new Date(), new Date())
    expect(await verifyImportedModelFile(record!, sha256, size)).toBe(false)
    await rm(file)
    expect(await verifyImportedModelFile(record!, sha256, size)).toBe(false)
  })
})
