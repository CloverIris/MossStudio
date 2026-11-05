import { describe, expect, it } from 'vitest'
import { DEFAULT_MOSSINFER_FLAVOUR, MOSSINFER_REPO, mossInferDriverCompatibilityError } from '@main/lib/engineAssets'

describe('engineAssets', () => {
  it('engine lookups follow the migrated upstream repository', () => {
    // xycld/owoinfer was renamed to mossimage-cpp/mossimage.cpp. GitHub redirects the
    // old slug, but a redirect hides which repository answered, so both the local and
    // the remote installer pin the canonical slug here.
    expect(MOSSINFER_REPO).toBe('mossimage-cpp/mossimage.cpp')
    expect(DEFAULT_MOSSINFER_FLAVOUR).toBe('cu13')
  })

  it('uses the engine probe driver minimums per OS', () => {
    expect(mossInferDriverCompatibilityError('cu13', '560.10', 'linux')).toContain('580.65.06')
    expect(mossInferDriverCompatibilityError('cu13', '560.10', 'linux')).toContain('560.10')
    expect(mossInferDriverCompatibilityError('cu13', '580.65.05', 'linux')).toContain('580.65.06')
    expect(mossInferDriverCompatibilityError('cu13', '580.65.06', 'linux')).toBeNull()
    expect(mossInferDriverCompatibilityError('cu13', '580.87', 'win32')).toContain('580.88')
    expect(mossInferDriverCompatibilityError('cu13', '581.15', 'win32')).toBeNull()
    expect(mossInferDriverCompatibilityError('cu12', '560.10', 'linux')).toBeNull()
    expect(mossInferDriverCompatibilityError('cu12', '520.61.05', 'linux')).toContain('525.60.13')
    expect(mossInferDriverCompatibilityError('cu12', '527.37', 'win32')).toContain('527.41')
  })

  it('an unknown driver version is not treated as incompatible', () => {
    expect(mossInferDriverCompatibilityError('cu13', undefined)).toBeNull()
    expect(mossInferDriverCompatibilityError('cu13', 'N/A')).toBeNull()
  })
})
