import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MOSSINFER_FLAVOUR,
  mossInferDriverCompatibilityError,
  mossInferArchitectureForComputeCapability,
  mossInferArchiveBase,
  nvidiaDriverMajor,
} from '../apps/desktop/src/main/lib/engineAssets.ts'

test('standard system-CUDA archive names remain unchanged', () => {
  assert.equal(
    mossInferArchiveBase('2.1.1', 'windows', 'cu13', 'system-cuda', 'standard'),
    'mossinfer-2.1.1-windows-cu13-x86_64-system-cuda',
  )
})

test('bundled release packages use CUDA 13 by default', () => {
  assert.equal(DEFAULT_MOSSINFER_FLAVOUR, 'cu13')
  assert.equal(
    mossInferArchiveBase('2.1.1', 'windows', DEFAULT_MOSSINFER_FLAVOUR, 'bundled', 'standard'),
    'mossinfer-2.1.1-windows-cu13-x86_64',
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
  // RTX 3060 reports SM 8.6 and uses the standard (SM80+) build.
  assert.equal(mossInferArchitectureForComputeCapability(7, 5), 'sm75')
  assert.equal(mossInferArchitectureForComputeCapability(8, 0), 'standard')
  assert.equal(mossInferArchitectureForComputeCapability(8, 6), 'standard')
  assert.equal(mossInferArchitectureForComputeCapability(9, 0), 'standard')
  assert.equal(mossInferArchitectureForComputeCapability(7, 0), null)
})

test('CUDA 13 requires an R580-or-newer NVIDIA driver and never silently falls back', () => {
  assert.equal(nvidiaDriverMajor('560.10'), 560)
  assert.equal(nvidiaDriverMajor('581.15'), 581)
  assert.equal(nvidiaDriverMajor('N/A'), null)
  assert.match(mossInferDriverCompatibilityError('cu13', '560.10') ?? '', /R580/)
  assert.equal(mossInferDriverCompatibilityError('cu13', '581.15'), null)
  assert.equal(mossInferDriverCompatibilityError('cu12', '560.10'), null)
})
