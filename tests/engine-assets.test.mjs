import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mossInferArchitectureForComputeCapability,
  mossInferArchiveBase,
} from '../apps/desktop/src/main/lib/engineAssets.ts'

test('standard system-CUDA archive names remain unchanged', () => {
  assert.equal(
    mossInferArchiveBase('2.1.1', 'windows', 'cu13', 'system-cuda', 'standard'),
    'mossinfer-2.1.1-windows-cu13-x86_64-system-cuda',
  )
})

test('SM75 release package names match upstream suffix ordering', () => {
  assert.equal(
    mossInferArchiveBase('2.1.1', 'windows', 'cu13', 'bundled', 'sm75'),
    'mossinfer-2.1.1-windows-cu13-x86_64-sm75',
  )
  assert.equal(
    mossInferArchiveBase('2.1.1', 'windows', 'cu13', 'system-cuda', 'sm75'),
    'mossinfer-2.1.1-windows-cu13-x86_64-sm75-system-cuda',
  )
})

test('automatic architecture selection is derived from compute capability', () => {
  assert.equal(mossInferArchitectureForComputeCapability(7, 5), 'sm75')
  assert.equal(mossInferArchitectureForComputeCapability(8, 0), 'standard')
  assert.equal(mossInferArchitectureForComputeCapability(9, 0), 'standard')
  assert.equal(mossInferArchitectureForComputeCapability(7, 0), null)
})
