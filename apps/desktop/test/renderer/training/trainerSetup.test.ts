import { describe, expect, it, vi } from 'vitest'
import { Ipc } from '@shared/channels'
import type { TrainerVersion } from '@shared/types'
import {
  currentVersion,
  defaultBranch,
  optionalUrlError,
  prepareTrainer,
  trainerApi,
  versionsAt,
  type TrainerApi,
} from '@renderer/pages/training/trainerSetup'
import { resolveTrainingHost, announceTrainingHost, getSelectedTrainingHost, TRAINING_HOST_EVENT } from '@renderer/lib/trainingHost'

function version(patch: Partial<TrainerVersion> = {}): TrainerVersion {
  return {
    id: 'v-aaa', hostId: 'local', name: 'main-aaa', branch: 'main', commit: 'aaaaaaa1', shortCommit: 'aaaaaaa',
    commitDate: '2026-10-01T00:00:00.000Z', subject: 'init', author: 'k', channel: 'stable', path: '/t/v', runtimeId: 'r',
    runtimeState: 'ready', createdAt: '2026-10-01T00:00:00.000Z', dirty: false, status: 'ok', ...patch,
  }
}

function fakeApi(created: TrainerVersion): TrainerApi & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    branches: async () => { calls.push('branches'); return [{ name: 'dev', sha: '', isDefault: false, isStable: false }, { name: 'main', sha: '', isDefault: true, isStable: true }] },
    commits: async (branch) => { calls.push(`commits:${branch}`); return [{ sha: created.commit, short: created.shortCommit, date: '', subject: '', author: '' }] },
    create: async (branch, commit) => { calls.push(`create:${branch}:${commit}`); return created },
    install: async (target) => { calls.push(`install:${target.id}`) },
  }
}

describe('trainer versions', () => {
  const versions = [
    version({ id: 'old', createdAt: '2026-10-01' }),
    version({ id: 'new-broken', createdAt: '2026-10-03', runtimeState: 'error' }),
    version({ id: 'remote', hostId: 'gpu-box', createdAt: '2026-10-05' }),
  ]

  it('groups by location, newest first', () => {
    expect(versionsAt(versions, 'local').map((item) => item.id)).toEqual(['new-broken', 'old'])
  })

  it('prefers the newest ready version', () => {
    expect(currentVersion(versions, 'local')?.id).toBe('old')
    expect(currentVersion([versions[1]!], 'local')?.id).toBe('new-broken')
    expect(currentVersion(versions, 'nowhere')).toBeUndefined()
  })

  it('picks the default branch', () => {
    expect(defaultBranch([{ name: 'a', sha: '', isDefault: false, isStable: false }, { name: 'b', sha: '', isDefault: true, isStable: false }])).toBe('b')
    expect(defaultBranch([])).toBe('main')
  })
})

describe('prepareTrainer', () => {
  it('fetches, creates the default branch head and installs its environment', async () => {
    const created = version({ id: 'v-new', commit: 'bbbbbbb2', runtimeState: 'missing' })
    const api = fakeApi(created)
    const steps: string[] = []
    const result = await prepareTrainer(api, undefined, (step) => steps.push(step))
    expect(api.calls).toEqual(['branches', 'commits:main', 'create:main:bbbbbbb2', 'install:v-new'])
    expect(steps).toEqual(['fetch', 'create', 'install'])
    expect(result).toMatchObject({ updated: true, installed: true, version: { id: 'v-new', runtimeState: 'ready' } })
  })

  it('reports "already up to date" without reinstalling', async () => {
    const current = version()
    const api = fakeApi(current)
    const result = await prepareTrainer(api, current)
    expect(api.calls).not.toContain('install:v-aaa')
    expect(result).toMatchObject({ updated: false, installed: false })
  })

  it('fails plainly when the branch has no commits', async () => {
    const api = { ...fakeApi(version()), commits: async () => [] }
    await expect(prepareTrainer(api, undefined)).rejects.toThrow('main 分支没有可用的提交')
  })
})

describe('trainerApi', () => {
  it('uses local channels for this computer and remote channels for SSH hosts', async () => {
    const call = vi.fn(async () => [] as never)
    await trainerApi(call, 'local').commits('main')
    await trainerApi(call, 'box').commits('main')
    await trainerApi(call, 'box').install(version({ id: 'v9' }))
    expect(call.mock.calls).toEqual([
      [Ipc.trainerCommits, { branch: 'main', limit: 1 }],
      [Ipc.trainerRemoteCommits, { hostId: 'box', branch: 'main', limit: 1 }],
      [Ipc.trainerRemoteInstall, { hostId: 'box', versionId: 'v9' }],
    ])
  })
})

describe('optionalUrlError', () => {
  it('allows empty and http(s) addresses only', () => {
    expect(optionalUrlError('')).toBeNull()
    expect(optionalUrlError(' https://pypi.org/simple ')).toBeNull()
    expect(optionalUrlError('ftp://x')).not.toBeNull()
    expect(optionalUrlError('pypi.org')).not.toBeNull()
  })
})

describe('training location', () => {
  const hosts = [{ id: 'local', kind: 'local' }, { id: 'box', kind: 'ssh' }]

  it('only uses a remote host while the feature is on and the host exists', () => {
    expect(resolveTrainingHost('box', hosts, true)).toBe('box')
    expect(resolveTrainingHost('box', hosts, false)).toBe('local')
    expect(resolveTrainingHost('gone', hosts, true)).toBe('local')
    expect(resolveTrainingHost(null, hosts, true)).toBe('local')
  })

  it('remembers the choice and tells other views', () => {
    const heard = vi.fn()
    window.addEventListener(TRAINING_HOST_EVENT, heard)
    announceTrainingHost('box')
    window.removeEventListener(TRAINING_HOST_EVENT, heard)
    expect(getSelectedTrainingHost()).toBe('box')
    expect(heard).toHaveBeenCalledTimes(1)
  })
})
