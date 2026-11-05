import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MOSSINFER_FLAVOUR,
  MOSSINFER_REPO,
  mossInferArchitectureForComputeCapability,
  mossInferArchiveBase,
  mossInferDriverCompatibilityError,
  nvidiaDriverMajor,
} from '@main/lib/engineAssets'

describe('engineAssets', () => {
  it('engine lookups follow the migrated upstream repository', () => {
    // xycld/owoinfer was renamed to mossimage-cpp/mossimage.cpp. GitHub redirects the
    // old slug, but a redirect hides which repository answered, so both the local and
    // the remote installer pin the canonical slug here.
    expect(MOSSINFER_REPO).toBe('mossimage-cpp/mossimage.cpp')
  })

  it('standard system-CUDA archive names remain unchanged', () => {
    expect(mossInferArchiveBase('2.1.1', 'windows', 'cu13', 'system-cuda', 'standard')).toBe(
      'mossinfer-2.1.1-windows-cu13-x86_64-system-cuda',
    )
    expect(mossInferArchiveBase('2.1.1', 'linux', 'cu12', 'system-cuda', 'standard')).toBe(
      'mossinfer-2.1.1-linux-cu12-x86_64-system-cuda',
    )
  })

  it('bundled release packages use CUDA 13 by default', () => {
    expect(DEFAULT_MOSSINFER_FLAVOUR).toBe('cu13')
    expect(mossInferArchiveBase('2.1.1', 'windows', DEFAULT_MOSSINFER_FLAVOUR, 'bundled', 'standard')).toBe(
      'mossinfer-2.1.1-windows-cu13-x86_64',
    )
  })

  it('SM75 release package names match upstream suffix ordering', () => {
    expect(mossInferArchiveBase('2.1.1', 'windows', 'cu13', 'bundled', 'sm75')).toBe('mossinfer-2.1.1-windows-cu13-x86_64-sm75')
    expect(mossInferArchiveBase('2.1.1', 'windows', 'cu13', 'system-cuda', 'sm75')).toBe(
      'mossinfer-2.1.1-windows-cu13-x86_64-sm75-system-cuda',
    )
  })

  it('automatic architecture selection is derived from compute capability', () => {
    // RTX 3060 reports SM 8.6 and uses the standard (SM80+) build.
    expect(mossInferArchitectureForComputeCapability(7, 5)).toBe('sm75')
    expect(mossInferArchitectureForComputeCapability(8, 0)).toBe('standard')
    expect(mossInferArchitectureForComputeCapability(8, 6)).toBe('standard')
    expect(mossInferArchitectureForComputeCapability(9, 0)).toBe('standard')
    expect(mossInferArchitectureForComputeCapability(12, 0)).toBe('standard')
    expect(mossInferArchitectureForComputeCapability(7, 0)).toBeNull()
    expect(mossInferArchitectureForComputeCapability(7, 2)).toBeNull()
    expect(mossInferArchitectureForComputeCapability(6, 1)).toBeNull()
  })

  it('CUDA 13 requires an R580-or-newer NVIDIA driver and never silently falls back', () => {
    expect(nvidiaDriverMajor('560.10')).toBe(560)
    expect(nvidiaDriverMajor('581.15')).toBe(581)
    expect(nvidiaDriverMajor(' 580 ')).toBe(580)
    expect(nvidiaDriverMajor('N/A')).toBeNull()
    expect(nvidiaDriverMajor(undefined)).toBeNull()
    expect(nvidiaDriverMajor('')).toBeNull()
    expect(nvidiaDriverMajor('5x0.1')).toBeNull()
    expect(mossInferDriverCompatibilityError('cu13', '560.10') ?? '').toMatch(/R580/)
    expect(mossInferDriverCompatibilityError('cu13', '560.10')).toContain('560.10')
    expect(mossInferDriverCompatibilityError('cu13', '580.00')).toBeNull()
    expect(mossInferDriverCompatibilityError('cu13', '581.15')).toBeNull()
    expect(mossInferDriverCompatibilityError('cu12', '560.10')).toBeNull()
  })

  it('an unknown driver version is not treated as incompatible', () => {
    expect(mossInferDriverCompatibilityError('cu13', undefined)).toBeNull()
    expect(mossInferDriverCompatibilityError('cu13', 'N/A')).toBeNull()
  })
})
