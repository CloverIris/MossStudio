import { describe, expect, it } from 'vitest'
import { diagnosticsReport } from '@renderer/pages/settings/diagnosticsReport'
import { diagnosticFixture, engineReadyFixture, envReportFixture, gpuInventoryFixture, settingsFixture } from '@test/mocks/backend/fixtures'
import type { AppInfo } from '@shared/types'

const info: AppInfo = {
  name: 'MossStudio',
  version: '1.0.3',
  electron: '44.0.0',
  chrome: '140',
  node: '24',
  platform: 'win32',
  arch: 'x64',
  dataPath: 'C:/Users/secret/AppData',
  modelsPath: 'C:/models',
  modelDirectories: { dit: '', textEncoder: '', vae: '', support: '', adapters: '' },
  acrylic: false,
}

describe('diagnosticsReport', () => {
  it('lists versions, GPUs, engine and recent problems', () => {
    const text = diagnosticsReport(
      {
        info,
        env: envReportFixture({ checks: [{ id: 'git', group: 'tools', label: 'Git', value: '缺失', status: 'error', detail: '未安装' }] }),
        gpu: gpuInventoryFixture(),
        engine: engineReadyFixture(),
        settings: settingsFixture({ githubToken: 'ghp_secret', remoteHostsEnabled: true }),
        diagnostics: [diagnosticFixture({ title: '显存不足', count: 3 })],
      },
      new Date('2026-11-04T00:00:00Z'),
    )
    expect(text).toContain('MossStudio 1.0.3')
    expect(text).toContain('GPU 0 NVIDIA GeForce RTX 4090 · 24 GB · SM89 · 驱动 581.42')
    expect(text).toContain('引擎 MossInfer 已就绪')
    expect(text).toContain('远程主机 开')
    expect(text).toContain('- Git：缺失（未安装）')
    expect(text).toContain('显存不足 ×3')
  })

  it('never includes tokens or private paths', () => {
    const text = diagnosticsReport({
      info,
      env: null,
      gpu: null,
      engine: null,
      settings: settingsFixture({ githubToken: 'ghp_secret' }),
      diagnostics: [],
    })
    expect(text).not.toContain('ghp_secret')
    expect(text).not.toContain('secret/AppData')
    expect(text).toContain('GPU 未检测到')
  })
})
