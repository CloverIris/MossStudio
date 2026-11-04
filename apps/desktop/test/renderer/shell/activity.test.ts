import { describe, expect, it } from 'vitest'
import { solutionTarget } from '@renderer/components/shell/ActivityPanel'

describe('solutionTarget', () => {
  it('opens the settings section a rule names', () => {
    expect(solutionTarget({ label: '换镜像', action: 'open_settings', params: { tab: 'network' } })).toEqual({ route: '/settings/network' })
    expect(solutionTarget({ label: '改位置', action: 'open_settings', params: { tab: 'storage' } })).toEqual({ route: '/settings/storage' })
  })

  it('falls back to Settings for a missing or odd section name', () => {
    expect(solutionTarget({ label: '设置', action: 'open_settings' })).toEqual({ route: '/settings' })
    expect(solutionTarget({ label: '设置', action: 'open_settings', params: { tab: '../x' } })).toEqual({ route: '/settings' })
    expect(solutionTarget({ label: '设置', action: 'open_settings', params: { tab: 3 } })).toEqual({ route: '/settings' })
  })

  it('maps job logs, models, engine fixes and copying', () => {
    expect(solutionTarget({ label: '日志', action: 'open_job_log' })).toEqual({ job: true })
    expect(solutionTarget({ label: '日志', action: 'open_log' })).toEqual({ job: true })
    expect(solutionTarget({ label: '模型', action: 'models' })).toEqual({ route: '/models' })
    expect(solutionTarget({ label: '引擎', action: 'repair_runtime' })).toEqual({ route: '/settings/devices' })
    expect(solutionTarget({ label: '复制', action: 'copy_diagnostics' })).toEqual({ copy: true })
  })

  it('hides actions that have no real fix', () => {
    expect(solutionTarget({ label: '降低设置重试', action: 'retry_lower' })).toBeNull()
    expect(solutionTarget({ label: '?', action: 'something_new' })).toBeNull()
  })
})
