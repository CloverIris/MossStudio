import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaunchDevice, TrainingHost } from '@shared/types'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'

const state = {
  devices: [] as LaunchDevice[],
  nvidia: 0,
  probe: vi.fn(),
  trust: vi.fn(async () => false),
}
vi.mock('@main/lib/run', () => ({ run: async () => ({ code: state.nvidia, stdout: '', stderr: '', timedOut: false }) }))
vi.mock('@main/services/devices', () => ({ listDevices: () => state.devices }))
vi.mock('@main/services/ssh', () => ({ probeHost: (...args: unknown[]) => state.probe(...args) }))
vi.mock('@main/services/sshHostKeys', () => ({ trustUnknownHost: (...args: unknown[]) => state.trust(...(args as [])) }))
vi.mock('@main/services/sshCredentials', () => ({ hasSshPassword: () => false, saveSshPassword: () => undefined, removeSshPassword: () => undefined }))
vi.mock('@main/services/hfCredentials', () => ({ hasHfToken: (id: string) => id === 'with-token', saveHfToken: vi.fn() }))

const root = useTempDataRoot()
const settings = settingsFixture()
const input = { name: '  ', host: 'gpu.test', user: ' moss ', trainerRoot: ' ~/t ' }
const stored = (): TrainingHost[] => JSON.parse(readFileSync(join(root(), 'hosts.json'), 'utf8'))

beforeEach(() => {
  vi.resetModules()
  state.devices = []
  state.nvidia = 0
  state.probe.mockReset()
  state.trust.mockReset().mockResolvedValue(false)
})
const load = () => import('@main/services/trainingHosts')

describe('inventory', () => {
  it('always lists the local host first with resolved paths', async () => {
    const { listTrainingHosts } = await load()
    expect(listTrainingHosts(settings)).toEqual([{
      id: 'local', name: '本机', kind: 'local', status: 'unchecked',
      trainerRoot: join(root(), 'trainer'), instanceRoot: join(root(), 'instances'), modelsRoot: join(root(), 'models'),
    }])
  })

  it('migrates the legacy training-hosts.json once without touching it', async () => {
    const legacy = [{ id: 'ssh-old', name: 'Old', kind: 'ssh', host: 'h', user: 'u', trainerRoot: '~', status: 'ok' }]
    writeFileSync(join(root(), 'training-hosts.json'), JSON.stringify(legacy))
    const { listTrainingHosts } = await load()
    expect(listTrainingHosts(settings).map((host) => host.id)).toEqual(['local', 'ssh-old'])
    expect(stored()).toEqual(legacy)
    expect(JSON.parse(readFileSync(join(root(), 'training-hosts.json'), 'utf8'))).toEqual(legacy)
  })

  it('ignores corrupt or non-array host files', async () => {
    writeFileSync(join(root(), 'hosts.json'), '{')
    expect((await load()).listTrainingHosts(settings)).toHaveLength(1)
    vi.resetModules()
    writeFileSync(join(root(), 'hosts.json'), '{"id":1}')
    expect((await load()).listTrainingHosts(settings)).toHaveLength(1)
  })
})

describe('saveTrainingHost', () => {
  it('trims input, falls back to the host as name and defaults port/auth', async () => {
    const { saveTrainingHost } = await load()
    const saved = saveTrainingHost(input)
    expect(saved).toMatchObject({ name: 'gpu.test', host: 'gpu.test', user: 'moss', trainerRoot: '~/t', port: 22, authMethod: 'identityFile', hasPassword: false, status: 'unchecked' })
    expect(saved.id).toMatch(/^ssh-[0-9a-f]{8}$/)
    expect(stored()).toHaveLength(1)
    expect(saveTrainingHost({ ...input, name: ' Named ', host: ' spaced.test ' })).toMatchObject({ name: 'Named', host: 'spaced.test' })
  })

  it('keeps optional paths on edit unless explicitly cleared', async () => {
    const { saveTrainingHost } = await load()
    const first = saveTrainingHost({ ...input, engineRoot: '/e', downloadProxy: 'http://p', hfEndpoint: 'https://hf', downloadConcurrency: 3, modelsRoot: '/m' })
    const edited = saveTrainingHost({ ...input, id: first.id })
    expect(edited).toMatchObject({ engineRoot: '/e', downloadProxy: 'http://p', hfEndpoint: 'https://hf', downloadConcurrency: 3, modelsRoot: undefined })
    const cleared = saveTrainingHost({ ...input, id: first.id, downloadProxy: '  ', hfEndpoint: '', downloadConcurrency: null })
    expect(cleared).toMatchObject({ downloadProxy: undefined, hfEndpoint: undefined, downloadConcurrency: undefined, engineRoot: '/e' })
    expect(stored()).toHaveLength(1)
  })

  it('saves or clears the per-host HF token', async () => {
    const { saveTrainingHost } = await load()
    const { saveHfToken } = await import('@main/services/hfCredentials')
    const saved = saveTrainingHost({ ...input, hfToken: 'hf_1' })
    expect(saveHfToken).toHaveBeenCalledWith(saved.id, 'hf_1')
    saveTrainingHost({ ...input, id: saved.id, clearHfToken: true, hfToken: 'ignored' })
    expect(saveHfToken).toHaveBeenLastCalledWith(saved.id, null)
  })
})

describe('host updates', () => {
  it('updates paths, model path and versions, and rejects unknown hosts', async () => {
    const { saveTrainingHost, updateTrainingHostPaths, updateTrainingHostModelPath, updateTrainingHostVersions } = await load()
    const saved = saveTrainingHost(input)
    updateTrainingHostPaths(saved.id, { engineRoot: ' /e2 ', outputRoot: ' ', modelsRoot: '/m2' })
    updateTrainingHostModelPath(saved.id, '/model')
    updateTrainingHostVersions(settings, saved.id, [])
    updateTrainingHostVersions(settings, 'missing', [])
    expect(stored()[0]).toMatchObject({ engineRoot: '/e2', modelsRoot: '/m2', modelPath: '/model', versions: [] })
    expect(stored()[0]!.outputRoot).toBeUndefined()
    expect(() => updateTrainingHostPaths('missing', {})).toThrow('主机不存在')
    expect(() => updateTrainingHostModelPath('missing', '/x')).toThrow('主机不存在')
  })

  it('removes hosts and their secrets', async () => {
    const { saveTrainingHost, removeTrainingHost, listTrainingHosts } = await load()
    const saved = saveTrainingHost(input)
    removeTrainingHost(saved.id)
    expect(listTrainingHosts(settings)).toHaveLength(1)
    expect(stored()).toEqual([])
  })
})

describe('testTrainingHost', () => {
  it('checks local CUDA via nvidia-smi', async () => {
    const { testTrainingHost } = await load()
    expect((await testTrainingHost(settings, 'local')).status).toBe('ok')
    state.nvidia = 1
    const failed = await testTrainingHost(settings, 'local')
    expect(failed.status).toBe('error')
    expect(failed.error).toMatch(/NVIDIA CUDA/)
    await expect(testTrainingHost(settings, 'nope')).rejects.toThrow('训练主机不存在')
  })

  it('stores the probe result on success and a truncated error on failure', async () => {
    const { saveTrainingHost, testTrainingHost } = await load()
    const saved = saveTrainingHost(input)
    state.probe.mockResolvedValueOnce({ os: 'Linux', gpu: 'A100, 81920', git: 'git', uv: '', python: 'Python 3.12', rootReady: true, raw: 'raw' })
    const ok = await testTrainingHost(settings, saved.id)
    expect(ok).toMatchObject({ status: 'ok', error: undefined, remote: { os: 'Linux', gpu: 'A100, 81920', rootReady: true } })
    expect(stored()[0]!.status).toBe('ok')
    state.probe.mockRejectedValueOnce(new Error('x'.repeat(3000)))
    const failed = await testTrainingHost(settings, saved.id)
    expect(failed.status).toBe('error')
    expect(failed.error).toHaveLength(2000)
    expect(state.trust).toHaveBeenCalledOnce()
  })

  it('retries the probe once after the user trusts a new host key', async () => {
    const { saveTrainingHost, testTrainingHost } = await load()
    const saved = saveTrainingHost(input)
    state.probe.mockRejectedValueOnce(new Error('No ED25519 host key is known for gpu.test'))
      .mockResolvedValueOnce({ os: 'Linux', gpu: '', git: '', uv: '', python: '', rootReady: false, raw: '' })
    state.trust.mockResolvedValueOnce(true)
    expect((await testTrainingHost(settings, saved.id)).status).toBe('ok')
    expect(state.probe).toHaveBeenCalledTimes(2)
  })
})

describe('managed hosts', () => {
  it('parses remote GPU rows into devices only for healthy SSH hosts', async () => {
    writeFileSync(join(root(), 'hosts.json'), JSON.stringify([
      { id: 'a', name: 'A', kind: 'ssh', host: 'a', user: 'u', trainerRoot: '~', status: 'ok', remote: { gpu: 'NVIDIA A100, 81920\n\nRTX, bogus\n, 1024' } },
      { id: 'b', name: 'B', kind: 'ssh', host: 'b', user: 'u', trainerRoot: '~', status: 'error', remote: { gpu: 'NVIDIA A100, 81920' } },
    ]))
    const { listManagedHosts } = await load()
    const [, a, b] = listManagedHosts(settings)
    expect(a!.devices).toEqual([
      { id: 'a:cuda:0', hostId: 'a', hostName: 'A', name: 'NVIDIA A100', kind: 'cuda', detail: 'CUDA · 80 GB', memoryBytes: 81920 * 1024 * 1024, available: true, source: 'remote' },
      expect.objectContaining({ id: 'a:cuda:1', name: 'RTX', detail: 'CUDA · 显存未知', memoryBytes: undefined }),
      expect.objectContaining({ id: 'a:cuda:2', name: 'GPU 2', detail: 'CUDA · 1 GB' }),
    ])
    expect(b!.devices).toEqual([])
    expect(b!.status).toBe('error')
  })

  it('labels the CPU distinctly when it shares a name with the MPS device and marks local ok', async () => {
    state.devices = [
      { id: 'mps', name: 'Apple M3', kind: 'mps', detail: 'Metal', available: true },
      { id: 'cpu', name: 'Apple M3', kind: 'cpu', detail: 'CPU', available: true },
    ]
    const { listManagedHosts, testManagedHost } = await load()
    const local = listManagedHosts(settings)[0]!
    expect(local.status).toBe('ok')
    expect(local.devices.map((device) => [device.name, device.hostId, device.source])).toEqual([
      ['Apple M3', 'local', 'local'], ['Apple M3 · CPU', 'local', 'local'],
    ])
    state.nvidia = 1
    // The local device manager never runs the trainer's CUDA check.
    expect((await testManagedHost(settings, 'local')).status).toBe('ok')
    expect(existsSync(join(root(), 'hosts.json'))).toBe(false)
  })
})
