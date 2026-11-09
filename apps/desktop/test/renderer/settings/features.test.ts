import { describe, expect, it } from 'vitest'
import { FEATURES, featureEnabled, featureVisibility } from '@renderer/lib/features'
import { settingsFixture } from '@test/mocks/backend/fixtures'

describe('optional features', () => {
  it('lists remote hosts, training, 看图拆区域 and LAN access with an explanation each', () => {
    expect(FEATURES.map((feature) => feature.key)).toEqual(['remoteHostsEnabled', 'trainingEnabled', 'gbcEnabled', 'lanWebEnabled'])
    for (const feature of FEATURES) expect(feature.description.length).toBeGreaterThan(8)
  })

  it('hides everything until settings load', () => {
    expect(featureVisibility(null)).toEqual({ remoteHosts: false, training: false, gbc: false, lan: false })
    expect(featureEnabled(undefined, 'trainingEnabled')).toBe(false)
  })

  it('follows the switches', () => {
    const settings = settingsFixture({ remoteHostsEnabled: true, trainingEnabled: false, lanWebEnabled: true })
    expect(featureVisibility(settings)).toEqual({ remoteHosts: true, training: false, gbc: false, lan: true })
  })
})
