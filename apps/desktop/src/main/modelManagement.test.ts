import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { getSettings } from './services/settings'
import {
  componentSnapshot,
  deleteModel,
  getCatalog,
  importModelFolder,
  installBundle,
  listDownloads,
  startDownload,
} from './services/models'
import { bundleBinding, prepareModelBundle } from './services/modelBundles'
import { ensureDirs, paths } from './lib/paths'

export async function runModelManagementTests(): Promise<void> {
  const payloads: Record<string, Buffer> = {
    'transformer/config.json': Buffer.from('{}'),
    'transformer/model.safetensors': Buffer.from('dit-fixture'),
    'text_encoder/config.json': Buffer.from('{}'),
    'text_encoder/model.safetensors': Buffer.from('shared-te-fixture'),
    'vae/config.json': Buffer.from('{}'),
    'vae/model.safetensors': Buffer.from('shared-vae-fixture'),
    'tokenizer/tokenizer_config.json': Buffer.from('{}'),
    'tokenizer/tokenizer.json': Buffer.from('{}'),
    'model_index.json': Buffer.from('{}'),
    'pipeline_moss_image.py': Buffer.from('# pipeline fixture'),
    'scheduler/scheduler_config.json': Buffer.from('{}'),
    'sft/transformer/config.json': Buffer.from('{}'),
    'sft/transformer/model.safetensors': Buffer.from('fp16-fixed-fixture'),
  }
  const sha = '1'.repeat(40)
  const requested: string[] = []
  const server = createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '')
    res.setHeader('content-type', 'application/json')
    if (url.includes('/revision/')) return res.end(JSON.stringify({ sha }))
    if (url.includes('/tree/'))
      return res.end(
        JSON.stringify(
          Object.entries(payloads).map(([path, data]) => ({
            type: 'file',
            path,
            size: data.length,
            lfs: { oid: createHash('sha256').update(data).digest('hex') },
          })),
        ),
      )
    const file = url.split(`/resolve/${sha}/`)[1]
    if (!file || !payloads[file]) {
      res.statusCode = 404
      return res.end()
    }
    requested.push(file)
    res.end(payloads[file])
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address() as { port: number }
  const settings = {
    ...getSettings(),
    modelsRoot: join(app.getPath('userData'), 'test-models'),
    hfEndpoint: `http://127.0.0.1:${address.port}`,
  }
  ensureDirs(settings.modelsRoot)
  const wait = async (): Promise<void> => {
    const start = Date.now()
    while (listDownloads().some((t) => ['queued', 'running', 'verifying'].includes(t.state))) {
      if (Date.now() - start > 10_000) throw new Error('Fixture downloads timed out')
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.deepEqual(
      listDownloads()
        .filter((t) => t.state === 'error')
        .map((t) => t.error),
      [],
    )
  }
  try {
    let catalog = await getCatalog(settings, true)
    assert.equal(catalog.bundles.length, 4)
    assert(catalog.models.filter((m) => m.format === 'comfyui').every((m) => m.files?.length === 1))
    assert(catalog.models.filter((m) => m.role !== 'full').every((m) => m.files?.length))
    assert.equal((await installBundle('moss-sft', settings)).length, 4)
    await wait()
    catalog = await getCatalog(settings, true)
    const sft = catalog.bundles.find((b) => b.id === 'moss-sft')!
    assert(
      [...Object.values(sft.components), sft.support].every(
        (id) => catalog.models.find((m) => m.id === id)?.installed,
      ),
    )
    const path = await prepareModelBundle(bundleBinding(sft), settings)
    assert.equal(
      (await readFile(join(path, 'transformer/model.safetensors'))).toString(),
      'dit-fixture',
    )
    assert.equal(await prepareModelBundle(bundleBinding(sft), settings), path)
    assert.equal((await installBundle('moss-sft', settings)).length, 0)
    const previous = requested.length
    assert.equal((await installBundle('moss-base', settings)).length, 1)
    await wait()
    assert(requested.slice(previous).every((p) => p.startsWith('transformer/')))
    await installBundle('moss-sft-fp16', settings)
    await wait()
    const fixed = catalog.bundles.find((b) => b.id === 'moss-sft-fp16')!
    const fixedPath = await prepareModelBundle(bundleBinding(fixed), settings)
    assert.equal(
      (await readFile(join(fixedPath, 'transformer/model.safetensors'))).toString(),
      'fp16-fixed-fixture',
    )
    const fixedManifest = JSON.parse(await readFile(join(fixedPath, 'clover_model.json'), 'utf8'))
    assert.equal(
      fixedManifest.components.find((c: { role: string }) => c.role === 'dit').precision,
      'fp16',
    )
    // A complete directory name alone is never readiness evidence.
    await writeFile(join(path, 'vae/model.safetensors'), 'broken')
    catalog = await getCatalog(settings, true)
    assert.equal(catalog.models.find((m) => m.id === 'flux2-vae-small')?.installed, false)
    await startDownload('model', 'flux2-vae-small', settings)
    await wait()
    const repaired = await prepareModelBundle(bundleBinding(sft), settings)
    assert.equal(
      (await readFile(join(repaired, 'vae/model.safetensors'))).toString(),
      'shared-vae-fixture',
    )
    // Existing HF blobs are adopted after verification without requesting their bytes.
    const imported = { ...settings, modelsRoot: join(app.getPath('userData'), 'imported-models') }
    ensureDirs(imported.modelsRoot)
    const oldBlobs = join(
      paths.hub(imported.modelsRoot),
      'models--OpenMOSS-Team--MOSS-Image-Base',
      'blobs',
    )
    await mkdir(oldBlobs, { recursive: true })
    const te = payloads['text_encoder/model.safetensors']!
    await writeFile(join(oldBlobs, createHash('sha256').update(te).digest('hex')), te)
    const oldRequests = requested.filter((p) => p === 'text_encoder/model.safetensors').length
    await startDownload('model', 'qwen35-encoder', imported)
    await wait()
    assert.equal(
      requested.filter((p) => p === 'text_encoder/model.safetensors').length,
      oldRequests,
    )
    assert((await componentSnapshot('qwen35-encoder', imported)).record.entries.length > 0)
    const encoder = (await getCatalog(imported, true)).models.find((model) => model.id === 'qwen35-encoder')!
    const encoderCacheName = `models--${encoder.repo.replace('/', '--')}`
    const legacyEncoderCache = join(paths.hub(imported.modelsRoot), encoderCacheName)
    await cp(
      join(paths.roleHub('text_encoder', imported.modelsRoot, imported.modelDirectories), encoderCacheName),
      legacyEncoderCache,
      { recursive: true },
    )
    const relocated = {
      ...imported,
      modelDirectories: {
        ...imported.modelDirectories,
        textEncoder: join(app.getPath('userData'), 'custom-text-encoder'),
      },
    }
    ensureDirs(relocated.modelsRoot, relocated.modelDirectories)
    assert.equal(
      (await getCatalog(relocated, true)).models.find((model) => model.id === 'qwen35-encoder')?.installed,
      true,
    )
    assert((await componentSnapshot('qwen35-encoder', relocated)).root.startsWith(legacyEncoderCache))
    const external = {
      ...settings,
      modelsRoot: join(app.getPath('userData'), 'external-model-import'),
    }
    ensureDirs(external.modelsRoot)
    const externalDir = join(external.modelsRoot, 'ComfyUI', 'models', 'text_encoders')
    await mkdir(externalDir, { recursive: true })
    await writeFile(join(externalDir, 'qwen.safetensors'), te)
    assert.deepEqual(await importModelFolder(join(external.modelsRoot, 'ComfyUI', 'models'), external), {
      added: 1,
      duplicates: 0,
    })
    const importedCatalog = await getCatalog(external, true)
    const localModel = importedCatalog.models.find((model) => model.provider === 'local')
    assert.equal(localModel?.installed, true)
    const modelRequests = requested.filter((p) => p === 'text_encoder/model.safetensors').length
    await startDownload('model', 'qwen35-encoder', external)
    await wait()
    assert.equal(
      requested.filter((p) => p === 'text_encoder/model.safetensors').length,
      modelRequests,
    )
    await deleteModel('model', localModel!.id, external)
    assert.equal((await readFile(join(externalDir, 'qwen.safetensors'))).toString(), te.toString())
    // Deleting one bundle's main model keeps the components other bundles share.
    await deleteModel('model', 'moss-sft-fp16-fixed', settings)
    catalog = await getCatalog(settings, true)
    assert.equal(catalog.models.find((m) => m.id === 'moss-sft-fp16-fixed')?.installed, false)
    assert.equal(catalog.models.find((m) => m.id === 'qwen35-encoder')?.installed, true)
    console.log(
      JSON.stringify({
        scenario: 'model-management',
        passed: true,
        checks: [
          'catalog',
          'bundle-install',
          'shared-components',
          'base-switch',
          'fp16-assembly',
          'corruption-repair',
          'legacy-blob-reuse',
          'external-model-import',
          'safe-delete',
        ],
      }),
    )
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
  }
}
