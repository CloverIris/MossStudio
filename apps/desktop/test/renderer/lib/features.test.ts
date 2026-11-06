import { describe, expect, it } from 'vitest'
import { FEATURES, featureEnabled, featureVisibility } from '@renderer/lib/features'
import { settingsFixture } from '../../mocks/backend'

describe('lib/features', () => {
  it('lists each optional feature once with copy', () => {
    expect(FEATURES.map((feature) => feature.key)).toEqual(['remoteHostsEnabled', 'trainingEnabled', 'lanWebEnabled'])
    expect(FEATURES.every((feature) => feature.label && feature.description)).toBe(true)
  })

  it('every optional feature is off in default settings', () => {
    expect(featureVisibility(settingsFixture())).toEqual({ remoteHosts: false, training: false, lan: false })
  })

  it('reads each toggle independently', () => {
    expect(featureVisibility(settingsFixture({ trainingEnabled: true }))).toEqual({ remoteHosts: false, training: true, lan: false })
    expect(featureVisibility(settingsFixture({ remoteHostsEnabled: true, lanWebEnabled: true }))).toEqual({
      remoteHosts: true,
      training: false,
      lan: true,
    })
  })

  it('treats missing settings as everything off', () => {
    expect(featureEnabled(null, 'trainingEnabled')).toBe(false)
    expect(featureEnabled(undefined, 'lanWebEnabled')).toBe(false)
    expect(featureVisibility(null)).toEqual({ remoteHosts: false, training: false, lan: false })
  })
})
