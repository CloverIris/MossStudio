/**
 * Remote inventory part of tools/test-onboarding.mjs. The old "directory globs"
 * download test now belongs to modelFiles.selectFiles (prepareRemoteModel only
 * delegates to remoteDownloads), so here it is reduced to the delegation contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogFixture, sshHostFixture, SFT_BUNDLE_IDS } from '@test/mocks/backend/fixtures'

const state = { files: [] as string[], commands: [] as string[] }
const startRemoteDownload = vi.fn(async (..._args: unknown[]) => ({ id: 'task' }))
vi.mock('@main/services/ssh', () => ({
  posixQuote: (value: string) => `'${value}'`,
  remoteAbsolute: async (_host: unknown, path: string) => path.replace(/^~\//, '/home/moss/'),
  sshExec: async (_host: unknown, command: string) => { state.commands.push(command); return { code: 0, stdout: state.files.join('\n'), stderr: '', timedOut: false } },
}))
vi.mock('@main/services/remoteDownloads', () => ({ startRemoteDownload: (...args: unknown[]) => startRemoteDownload(...args) }))

const { scanRemoteModels, prepareRemoteModel, prepareRemoteDefaultModel } = await import('@main/services/remoteModels')
const host = sshHostFixture({ modelsRoot: '/models' })
const catalog = catalogFixture()
const snapshot = '/models/hf/hub/models--OpenMOSS-Team--MOSS-Image-SFT/snapshots/aaa'
const remoteFiles = [
  'transformer/config.json', 'transformer/model-00001-of-00002.safetensors', 'transformer/model-00002-of-00002.safetensors',
  'text_encoder/config.json', 'text_encoder/model.safetensors', 'tokenizer/tokenizer_config.json', 'tokenizer/tokenizer.json',
  'vae/config.json', 'vae/model.safetensors', 'model_index.json', 'pipeline_moss_image.py', 'scheduler/scheduler_config.json',
].map((path) => `${snapshot}/${path}`)
const installed = async (files: string[]) => {
  state.files = files
  const inventory = await scanRemoteModels(host, catalog)
  return (id: string) => inventory.models.find((model) => model.id === id)!.installed
}

beforeEach(() => {
  state.files = []
  state.commands = []
  startRemoteDownload.mockClear()
})

describe('scanRemoteModels', () => {
  it('recognises a complete snapshot including pipeline and tokenizer', async () => {
    const has = await installed(remoteFiles)
    expect(SFT_BUNDLE_IDS.every(has)).toBe(true)
    expect(has('moss-base-dit')).toBe(false)
  })

  it.each([
    ['transformer/model-00002-of-00002.safetensors', 'moss-sft-dit'],
    ['tokenizer/tokenizer.json', 'qwen35-encoder'],
  ])('rejects a snapshot missing %s even if another revision has it', async (missing, id) => {
    const files = remoteFiles.filter((path) => path !== `${snapshot}/${missing}`)
    files.push(`${snapshot.replace('/aaa', '/bbb')}/${missing}`)
    expect((await installed(files))(id)).toBe(false)
  })

  it('accepts a vocab/merges tokenizer and requires the component config and scheduler', async () => {
    const vocab = remoteFiles.filter((path) => !path.endsWith('tokenizer/tokenizer.json')).concat(`${snapshot}/tokenizer/vocab.json`, `${snapshot}/tokenizer/merges.txt`)
    expect((await installed(vocab))('qwen35-encoder')).toBe(true)
    expect((await installed(remoteFiles.filter((path) => !path.endsWith('vae/config.json'))))('flux2-vae-small')).toBe(false)
    expect((await installed(remoteFiles.filter((path) => !path.endsWith('scheduler_config.json'))))('moss-pipeline')).toBe(false)
  })

  it('reports the resolved root, file count and snapshot path', async () => {
    state.files = [...remoteFiles, '', '  ']
    const inventory = await scanRemoteModels(host, catalog)
    expect(inventory.root).toBe('/models')
    expect(inventory.files).toBe(remoteFiles.length)
    expect(inventory.models.find((model) => model.id === 'moss-sft-dit')!.path).toBe(snapshot)
    expect(state.commands[0]).toContain("test -d '/models' && find '/models' -maxdepth 8")
  })

  it('falls back to the host or default models root', async () => {
    const inventory = await scanRemoteModels(sshHostFixture({ modelsRoot: undefined }), catalog)
    expect(inventory.root).toBe('/home/moss/.mossstudio/models')
    expect((await scanRemoteModels(host, catalog, '/override')).root).toBe('/override')
  })

  it('locates adapters by repo once every listed file is there', async () => {
    const adapter = catalog.adapters[0]!
    const token = `models--${adapter.repo.replace('/', '--')}`
    const snapshot = `/models/hf/hub/${token}/snapshots/s1`
    // One file of a multi-file adapter is an unfinished download, not an installed adapter.
    state.files = [`${snapshot}/${adapter.files[0]}`]
    if (adapter.files.length > 1) {
      expect((await scanRemoteModels(host, catalog)).adapters.find((entry) => entry.id === adapter.id)).toEqual({ id: adapter.id, installed: false, path: undefined })
    }
    state.files = adapter.files.map((file) => `${snapshot}/${file}`)
    const inventory = await scanRemoteModels(host, catalog)
    expect(inventory.adapters.find((entry) => entry.id === adapter.id)).toEqual({ id: adapter.id, installed: true, path: snapshot })
  })
})

describe('prepareRemoteModel', () => {
  it('starts a model download for catalog models and an adapter download for adapters', async () => {
    const model = catalog.models.find((entry) => entry.id === 'moss-sft-dit')!
    await prepareRemoteModel(host, model)
    expect(startRemoteDownload).toHaveBeenLastCalledWith(host, model, 'model')
    await prepareRemoteModel(host, catalog.adapters[0]!)
    expect(startRemoteDownload).toHaveBeenLastCalledWith(host, catalog.adapters[0], 'adapter')
  })

  it('prepares the default SFT snapshot as a whole-repo download', async () => {
    await prepareRemoteDefaultModel(host)
    expect(startRemoteDownload).toHaveBeenCalledWith(host, { id: 'default-sft', name: '默认 MOSS-Image SFT', repo: 'OpenMOSS-Team/MOSS-Image-SFT', revision: 'main', files: [], sizeBytes: 0 })
  })
})
