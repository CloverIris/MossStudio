import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterEntry, Catalog, ModelEntry, TrainingHost } from '@shared/types'

const sshExec = vi.hoisted(() => vi.fn())
const remoteAbsolute = vi.hoisted(() => vi.fn(async (_host: unknown, path: string) => path.replace(/^~/, '/home/u')))
const startRemoteDownload = vi.hoisted(() => vi.fn(async () => ({ id: 'task' })))
vi.mock('@main/services/ssh', () => ({
  posixQuote: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`,
  remoteAbsolute,
  sshExec,
}))
vi.mock('@main/services/remoteDownloads', () => ({ startRemoteDownload }))

import { prepareRemoteDefaultModel, prepareRemoteModel, scanRemoteModels } from '@main/services/remoteModels'

const host: TrainingHost = { id: 'gpu', name: 'GPU box', kind: 'ssh', host: 'h', user: 'u', trainerRoot: '~/t', status: 'ok' }
const ROOT = '/home/u/.mossstudio/models'
const snap = (repo: string, sha = 'a'.repeat(40)): string => `${ROOT}/hf/hub/models--${repo.replace('/', '--')}/snapshots/${sha}`

function model(patch: Partial<ModelEntry>): ModelEntry {
  return {
    id: 'm', name: 'm', provider: 'hf', repo: 'org/m', revision: 'main', role: 'dit', format: 'diffusers',
    precision: 'bf16', sizeBytes: 0, license: 'x', tags: [], installed: false, installedBytes: 0, ...patch,
  }
}
function adapter(patch: Partial<AdapterEntry>): AdapterEntry {
  return {
    id: 'a', name: 'a', provider: 'hf', repo: 'org/lora', revision: 'main', kind: 'lora', license: 'x',
    files: ['a.safetensors'], sizeBytes: 0, tags: [], installed: false, installedBytes: 0, ...patch,
  }
}
function catalog(models: ModelEntry[], adapters: AdapterEntry[] = []): Catalog {
  return { models, adapters, bundles: [], updatedAt: '', source: 'builtin' }
}
function remoteFiles(files: string[]): void {
  sshExec.mockResolvedValue({ code: 0, stdout: `${files.join('\n')}\n\n`, stderr: '', timedOut: false })
}

beforeEach(() => {
  sshExec.mockReset()
  remoteAbsolute.mockClear()
  startRemoteDownload.mockClear()
})

describe('scanRemoteModels', () => {
  it('runs one bounded, quoted find over the resolved models root', async () => {
    remoteFiles([])
    const result = await scanRemoteModels(host, catalog([]), "~/my models/it's")
    expect(remoteAbsolute).toHaveBeenCalledWith(host, "~/my models/it's")
    const [, command, timeout] = sshExec.mock.calls[0]!
    expect(command).toContain(`find '/home/u/my models/it'\\''s' -maxdepth 8 -type f -size +0c`)
    expect(command).toContain('head -n 20000')
    expect(timeout).toBe(120_000)
    expect(result).toEqual({ root: "/home/u/my models/it's", files: 0, models: [], adapters: [] })
  })

  it('prefers the explicit root, then the host root, then the default', async () => {
    remoteFiles([])
    await scanRemoteModels({ ...host, modelsRoot: '/data/models' }, catalog([]))
    expect(remoteAbsolute).toHaveBeenLastCalledWith(expect.anything(), '/data/models')
    await scanRemoteModels(host, catalog([]))
    expect(remoteAbsolute).toHaveBeenLastCalledWith(expect.anything(), '~/.mossstudio/models')
  })

  it('a diffusers DiT needs its config and every shard of one snapshot', async () => {
    const dit = model({ id: 'dit', repo: 'org/dit', subfolder: 'transformer', files: ['transformer/*'] })
    const s = snap('org/dit')
    remoteFiles([`${s}/transformer/config.json`, `${s}/transformer/m-00001-of-00002.safetensors`])
    expect((await scanRemoteModels(host, catalog([dit]))).models).toEqual([{ id: 'dit', installed: false, path: undefined }])
    remoteFiles([`${s}/transformer/config.json`, `${s}/transformer/m-00001-of-00002.safetensors`, `${s}/transformer/m-00002-of-00002.safetensors`])
    expect((await scanRemoteModels(host, catalog([dit]))).models).toEqual([{ id: 'dit', installed: true, path: s }])
    remoteFiles([`${s}/transformer/m.safetensors`])
    expect((await scanRemoteModels(host, catalog([dit]))).models[0]!.installed).toBe(false)
  })

  it('does not combine files from different snapshots and picks the complete one', async () => {
    const dit = model({ id: 'dit', repo: 'org/dit', subfolder: 'transformer', files: ['transformer/*'] })
    const old = snap('org/dit', 'b'.repeat(40))
    const fresh = snap('org/dit', 'c'.repeat(40))
    remoteFiles([`${old}/transformer/config.json`, `${fresh}/transformer/w.safetensors`])
    expect((await scanRemoteModels(host, catalog([dit]))).models[0]!.installed).toBe(false)
    remoteFiles([`${old}/transformer/config.json`, `${fresh}/transformer/config.json`, `${fresh}/transformer/w.safetensors`])
    expect((await scanRemoteModels(host, catalog([dit]))).models[0]!.path).toBe(fresh)
  })

  it('a text encoder needs a tokenizer config and tokenizer.json or vocab+merges', async () => {
    const te = model({ id: 'te', repo: 'org/te', role: 'text_encoder', subfolder: 'text_encoder', files: ['text_encoder/*', 'tokenizer/*'] })
    const s = snap('org/te')
    const base = [`${s}/text_encoder/config.json`, `${s}/text_encoder/model.safetensors`, `${s}/tokenizer/tokenizer_config.json`]
    remoteFiles(base)
    expect((await scanRemoteModels(host, catalog([te]))).models[0]!.installed).toBe(false)
    remoteFiles([...base, `${s}/tokenizer/vocab.json`, `${s}/tokenizer/merges.txt`])
    expect((await scanRemoteModels(host, catalog([te]))).models[0]!.installed).toBe(true)
    remoteFiles([...base, `${s}/tokenizer/tokenizer.json`])
    expect((await scanRemoteModels(host, catalog([te]))).models[0]!.installed).toBe(true)
  })

  it('a ComfyUI single file only needs the listed file', async () => {
    const comfy = model({ id: 'c', repo: 'org/c', format: 'comfyui', files: ['diffusion_models/x.safetensors'] })
    const s = snap('org/c')
    remoteFiles([`${s}/diffusion_models/y.safetensors`])
    expect((await scanRemoteModels(host, catalog([comfy]))).models[0]!.installed).toBe(false)
    remoteFiles([`${s}/diffusion_models/x.safetensors`])
    expect((await scanRemoteModels(host, catalog([comfy]))).models[0]!.installed).toBe(true)
  })

  it('support and full models need their entry files', async () => {
    const support = model({ id: 's', repo: 'org/s', role: 'support', files: ['model_index.json'] })
    const full = model({ id: 'f', repo: 'org/f', role: 'full' })
    remoteFiles([`${snap('org/s')}/model_index.json`, `${snap('org/f')}/transformer/config.json`])
    expect((await scanRemoteModels(host, catalog([support, full]))).models.map((m) => m.installed)).toEqual([false, false])
    remoteFiles([
      `${snap('org/s')}/model_index.json`, `${snap('org/s')}/scheduler/scheduler_config.json`,
      `${snap('org/f')}/model_index.json`,
    ])
    expect((await scanRemoteModels(host, catalog([support, full]))).models.map((m) => m.installed)).toEqual([true, true])
  })

  it('ignores files of other repositories and files outside snapshots', async () => {
    const comfy = model({ id: 'c', repo: 'org/c', format: 'comfyui', files: ['x.safetensors'] })
    remoteFiles([`${snap('org/other')}/x.safetensors`, `${ROOT}/hf/hub/models--org--c/blobs/x.safetensors`])
    expect((await scanRemoteModels(host, catalog([comfy]))).models[0]!.installed).toBe(false)
  })

  it('locates adapters in an HF cache or a plain folder', async () => {
    const hfLora = adapter({ id: 'hf', repo: 'org/lora' })
    const plain = adapter({ id: 'plain', repo: 'me/plain', files: ['p.safetensors'] })
    const absent = adapter({ id: 'absent', repo: 'org/none' })
    remoteFiles([`${snap('org/lora')}/a.safetensors`, `${ROOT}/me/plain/p.safetensors`])
    const result = await scanRemoteModels(host, catalog([], [hfLora, plain, absent]))
    expect(result.adapters).toEqual([
      { id: 'hf', installed: true, path: snap('org/lora') },
      { id: 'plain', installed: true, path: `${ROOT}/me/plain` },
      { id: 'absent', installed: false, path: undefined },
    ])
    expect(result.files).toBe(2)
  })

  it('propagates SSH failures', async () => {
    sshExec.mockRejectedValue(new Error('ssh: connect refused'))
    await expect(scanRemoteModels(host, catalog([]))).rejects.toThrow('connect refused')
  })
})

describe('prepareRemote*', () => {
  it('queues the default SFT model with a stable id', async () => {
    await prepareRemoteDefaultModel(host)
    expect(startRemoteDownload).toHaveBeenCalledWith(host, {
      id: 'default-sft', name: '默认 MOSS-Image SFT', repo: 'OpenMOSS-Team/MOSS-Image-SFT', revision: 'main', files: [], sizeBytes: 0,
    })
  })

  it('distinguishes models from adapters', async () => {
    await prepareRemoteModel(host, model({ id: 'm' }))
    expect(startRemoteDownload).toHaveBeenLastCalledWith(host, expect.objectContaining({ id: 'm' }), 'model')
    await prepareRemoteModel(host, adapter({ id: 'a' }))
    expect(startRemoteDownload).toHaveBeenLastCalledWith(host, expect.objectContaining({ id: 'a' }), 'adapter')
  })
})

describe('adapter detection', () => {
  it('needs every listed file, not just any file from the repo', async () => {
    const dmd = adapter({ id: 'dmd', repo: 'org/dmd', files: ['lora.safetensors', 'time_embedding.safetensors'] })
    remoteFiles([`${snap('org/dmd')}/lora.safetensors`])
    expect((await scanRemoteModels(host, catalog([], [dmd]))).adapters[0]).toEqual({ id: 'dmd', installed: false, path: undefined })
    remoteFiles([`${snap('org/dmd')}/lora.safetensors`, `${snap('org/dmd')}/time_embedding.safetensors`])
    expect((await scanRemoteModels(host, catalog([], [dmd]))).adapters[0]).toEqual({ id: 'dmd', installed: true, path: snap('org/dmd') })
  })

  it('does not count a different file in the same repo', async () => {
    const lora = adapter({ id: 'l', repo: 'org/lora', files: ['a.safetensors'] })
    remoteFiles([`${snap('org/lora')}/README.json`, `${snap('org/lora')}/other.safetensors`])
    expect((await scanRemoteModels(host, catalog([], [lora]))).adapters[0]!.installed).toBe(false)
  })
})

describe('deleteRemoteModels', () => {
  const sft = snap('OpenMOSS-Team/MOSS-Image-SFT')
  const dit = model({ id: 'dit', repo: 'OpenMOSS-Team/MOSS-Image-SFT', subfolder: 'transformer', files: ['transformer/*'] })
  const vae = model({ id: 'vae', role: 'vae', repo: 'OpenMOSS-Team/MOSS-Image-SFT', subfolder: 'vae', files: ['vae/*'] })
  const files = [
    `${sft}/transformer/config.json`, `${sft}/transformer/diffusion_pytorch_model.safetensors`,
    `${sft}/vae/config.json`, `${sft}/vae/diffusion_pytorch_model.safetensors`,
  ]

  it('deletes only the removed part of a shared snapshot', async () => {
    sshExec.mockResolvedValueOnce({ code: 0, stdout: files.join('\n'), stderr: '', timedOut: false })
    sshExec.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: false })
    const { deleteRemoteModels } = await import('@main/services/remoteModels')
    const result = await deleteRemoteModels(host, catalog([dit, vae]), ['dit'])
    expect(result.removed).toEqual([`${sft}/transformer`])
    const script = String(sshExec.mock.calls[1]![1])
    expect(script).toContain(`rm -rf -- '${sft}/transformer'`)
    expect(script).not.toMatch(new RegExp(`rm -rf -- '${sft}'( |$)`))
    expect(script).not.toContain(`'${sft}/vae'`)
  })

  it('refuses when the entry is not on the host and reports a failed command', async () => {
    const { deleteRemoteModels } = await import('@main/services/remoteModels')
    sshExec.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: false })
    await expect(deleteRemoteModels(host, catalog([dit, vae]), ['dit'])).rejects.toThrow('找不到要删除的文件')
    sshExec.mockResolvedValueOnce({ code: 0, stdout: files.join('\n'), stderr: '', timedOut: false })
    sshExec.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'Permission denied', timedOut: false })
    await expect(deleteRemoteModels(host, catalog([dit, vae]), ['dit'])).rejects.toThrow('Permission denied')
  })
})
