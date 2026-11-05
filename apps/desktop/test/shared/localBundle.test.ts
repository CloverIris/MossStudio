import { describe, expect, it } from 'vitest'
import { localFilesBundle } from '@shared/localBundle'
import type { ModelEntry } from '@shared/types'

const entry = (id: string, role: ModelEntry['role'], overrides: Partial<ModelEntry> = {}): ModelEntry => ({
  id,
  name: id,
  provider: 'local',
  repo: `C:/ComfyUI/models/${id}.safetensors`,
  revision: 'local',
  role,
  format: 'comfyui',
  family: 'local',
  precision: 'local',
  license: 'local',
  files: [`${id}.safetensors`],
  tags: [],
  localPath: `C:/ComfyUI/models/${id}.safetensors`,
  installed: true,
  installedBytes: 1,
  sizeBytes: 1,
  ...overrides,
})

const trio = () => [entry('dit-1', 'dit'), entry('te-1', 'text_encoder'), entry('vae-1', 'vae')]

describe('localFilesBundle', () => {
  it('forms one local bundle from the three scanned component roles', () => {
    expect(localFilesBundle(trio())).toEqual({
      id: 'local-files',
      name: '本地文件（扫描）',
      description: '直接使用本地已登记的单文件组件，不复制、不下载。',
      components: { dit: 'dit-1', textEncoder: 'te-1', vae: 'vae-1' },
      support: '',
      recommended: false,
    })
  })

  it('does not pretend a partial set is a bundle', () => {
    expect(localFilesBundle([entry('dit-1', 'dit'), entry('te-1', 'text_encoder')])).toBeNull()
    expect(localFilesBundle([entry('te-1', 'text_encoder'), entry('vae-1', 'vae')])).toBeNull()
    expect(localFilesBundle([entry('dit-1', 'dit'), entry('vae-1', 'vae')])).toBeNull()
    expect(localFilesBundle([])).toBeNull()
  })

  it('skips uninstalled and downloaded entries', () => {
    expect(localFilesBundle([entry('dit-1', 'dit', { installed: false }), entry('te-1', 'text_encoder'), entry('vae-1', 'vae')])).toBeNull()
    expect(
      localFilesBundle([
        entry('dit-1', 'dit', { installed: false }),
        entry('te-1', 'text_encoder'),
        entry('vae-1', 'vae'),
        entry('dit-downloaded', 'dit', { provider: 'hf', installed: true }),
      ]),
    ).toBeNull()
  })

  it('ignores full and support entries even when local', () => {
    expect(
      localFilesBundle([entry('full-1', 'full'), entry('support-1', 'support'), entry('te-1', 'text_encoder'), entry('vae-1', 'vae')]),
    ).toBeNull()
  })

  it('picks the first installed local entry per role, in list order', () => {
    const bundle = localFilesBundle([
      entry('dit-hf', 'dit', { provider: 'hf' }),
      entry('dit-missing', 'dit', { installed: false }),
      entry('dit-a', 'dit'),
      entry('dit-b', 'dit'),
      ...trio().slice(1),
      entry('vae-2', 'vae'),
    ])
    expect(bundle?.components).toEqual({ dit: 'dit-a', textEncoder: 'te-1', vae: 'vae-1' })
  })
})
