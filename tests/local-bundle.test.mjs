import test from 'node:test'
import assert from 'node:assert/strict'
import { localFilesBundle } from '../apps/desktop/src/shared/localBundle.ts'

const base = {
  provider: 'local',
  repo: 'C:/ComfyUI/models/x.safetensors',
  revision: 'local',
  format: 'comfyui',
  family: 'local',
  license: 'local',
  files: ['x.safetensors'],
  tags: [],
  installed: true,
  installedBytes: 1,
  sizeBytes: 1,
}

const entry = (id, role, overrides = {}) => ({
  ...base,
  id,
  name: id,
  role,
  precision: 'local',
  localPath: `C:/ComfyUI/models/${id}.safetensors`,
  ...overrides,
})

test('all three scanned component roles form one local bundle', () => {
  const bundle = localFilesBundle([
    entry('dit-1', 'dit'),
    entry('te-1', 'text_encoder'),
    entry('vae-1', 'vae'),
  ])
  assert.equal(bundle?.id, 'local-files')
  assert.deepEqual(bundle?.components, { dit: 'dit-1', textEncoder: 'te-1', vae: 'vae-1' })
})

test('a partially scanned set does not pretend to be a bundle', () => {
  assert.equal(localFilesBundle([entry('dit-1', 'dit'), entry('te-1', 'text_encoder')]), null)
  assert.equal(localFilesBundle([]), null)
})

test('uninstalled, missing-file or downloaded entries are not offered', () => {
  assert.equal(
    localFilesBundle([
      entry('dit-1', 'dit', { installed: false }),
      entry('te-1', 'text_encoder'),
      entry('vae-1', 'vae'),
    ]),
    null,
  )
  assert.equal(
    localFilesBundle([
      entry('dit-1', 'dit', { installed: false }),
      entry('te-1', 'text_encoder'),
      entry('vae-1', 'vae'),
      entry('dit-downloaded', 'dit', { provider: 'hf', installed: true }),
    ])?.components.dit,
    undefined,
  )
})
