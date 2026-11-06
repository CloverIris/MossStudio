import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobRecord, TrainerVersion } from '@shared/types'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'
import { jobFixture, settingsFixture, sshHostFixture } from '@test/mocks/backend/fixtures'

const state = {
  version: undefined as TrainerVersion | undefined,
  remoteFiles: new Set<string>(),
  findOutput: '',
  scpCode: 0,
  commands: [] as string[],
}
const registerTrainedAdapter = vi.fn(async (_settings: unknown, input: { id: string }) => ({ id: input.id }))
const scpFrom = vi.fn(async (_host: unknown, _source: string, target: string) => {
  if (state.scpCode === 0) writeFileSync(target, 'weights')
  return { code: state.scpCode, stdout: '', stderr: '', timedOut: false }
})
vi.mock('@main/services/settings', () => ({ getSettings: () => settingsFixture() }))
vi.mock('@main/services/trainers', () => ({ findTrainerVersion: async () => state.version }))
vi.mock('@main/services/trainingHosts', () => ({
  getTrainingHost: (_s: unknown, id: string) => (id === 'ssh-gpu' ? sshHostFixture() : undefined),
}))
vi.mock('@main/services/models', () => ({
  registerTrainedAdapter: (...args: [unknown, { id: string }]) => registerTrainedAdapter(...args),
}))
vi.mock('@main/services/ssh', () => ({
  remoteAbsolute: async (_host: unknown, path: string) => path.replace(/^~\//, '/home/moss/'),
  sshExec: async (_host: unknown, command: string) => {
    state.commands.push(command)
    const tested = /^test -f "(.*)"$/.exec(command)?.[1]
    if (tested) return { code: state.remoteFiles.has(tested) ? 0 : 1, stdout: '', stderr: '', timedOut: false }
    return { code: 0, stdout: state.findOutput, stderr: '', timedOut: false }
  },
  scpFrom: (...args: [unknown, string, string]) => scpFrom(...args),
}))

const root = useTempDataRoot()
const versionDir = useTempDir('trainer-version-')
const job = (patch: Partial<JobRecord> = {}): JobRecord =>
  jobFixture({
    kind: 'training',
    state: 'succeeded',
    trainerVersionId: 'v1',
    trainerRunName: 'my run/1',
    trainerWeights: 'moss-base',
    ...patch,
  } as Partial<JobRecord>)

beforeEach(() => {
  vi.resetModules()
  state.version = { id: 'v1', hostId: 'local', path: versionDir() } as TrainerVersion
  state.remoteFiles = new Set()
  state.findOutput = ''
  state.scpCode = 0
  state.commands = []
  registerTrainedAdapter.mockClear()
  scpFrom.mockClear()
})
const load = () => import('@main/services/trainerArtifacts')

describe('collectTrainerArtifact', () => {
  it('ignores jobs that are not finished training runs', async () => {
    const { collectTrainerArtifact } = await load()
    for (const patch of [
      { kind: 'generate' },
      { state: 'failed' },
      { trainerVersionId: undefined },
      { trainerRunName: undefined },
    ] as Array<Partial<JobRecord>>) {
      expect(await collectTrainerArtifact(job(patch))).toBeNull()
    }
    state.version = undefined
    expect(await collectTrainerArtifact(job())).toBeNull()
    expect(registerTrainedAdapter).not.toHaveBeenCalled()
  })

  it('registers a local export with a sanitised run name', async () => {
    mkdirSync(join(versionDir(), 'runs', 'moss', 'my-run-1', 'export'), { recursive: true })
    const source = join(versionDir(), 'runs', 'moss', 'my-run-1', 'export', 'my-run-1.safetensors')
    writeFileSync(source, 'x')
    const { collectTrainerArtifact } = await load()
    expect(await collectTrainerArtifact(job())).toBe('trained-my-run-1')
    expect(registerTrainedAdapter).toHaveBeenCalledWith(expect.anything(), {
      id: 'trained-my-run-1',
      name: 'my-run-1 · Kohaku Trainer',
      sourcePath: source,
      kind: 'lora',
      base: 'moss-base',
      license: 'local',
    })
  })

  it('prefers exports/<run>.safetensors and returns null when no local file exists', async () => {
    const { collectTrainerArtifact } = await load()
    expect(await collectTrainerArtifact(job())).toBeNull()
    mkdirSync(join(versionDir(), 'exports'))
    writeFileSync(join(versionDir(), 'exports', 'my-run-1.safetensors'), 'x')
    await collectTrainerArtifact(job())
    expect(registerTrainedAdapter.mock.calls[0]![1]).toMatchObject({ sourcePath: join(versionDir(), 'exports', 'my-run-1.safetensors') })
  })

  it('copies a remote export into the cache, registers it and removes the copy', async () => {
    state.version = { id: 'v/2', hostId: 'ssh-gpu', path: '~/trainer/v2' } as TrainerVersion
    state.remoteFiles.add('/home/moss/trainer/v2/runs/moss/my-run-1/export/my-run-1.safetensors')
    const { collectTrainerArtifact } = await load()
    expect(await collectTrainerArtifact(job())).toBe('trained-my-run-1')
    const target = join(root(), 'cache', 'trainer-artifacts', 'v-2-my-run-1.safetensors')
    expect(scpFrom).toHaveBeenCalledWith(expect.anything(), '/home/moss/trainer/v2/runs/moss/my-run-1/export/my-run-1.safetensors', target)
    expect(registerTrainedAdapter.mock.calls[0]![1]).toMatchObject({ sourcePath: target })
    expect(existsSync(target)).toBe(false)
  })

  it('falls back to any export file on the remote, and gives up on scp failure or missing host', async () => {
    state.version = { id: 'v2', hostId: 'ssh-gpu', path: '/t' } as TrainerVersion
    state.findOutput = '/t/runs/moss/my-run-1/export/other.safetensors\n'
    state.scpCode = 1
    const { collectTrainerArtifact } = await load()
    expect(await collectTrainerArtifact(job())).toBeNull()
    expect(scpFrom.mock.calls[0]![1]).toBe('/t/runs/moss/my-run-1/export/other.safetensors')
    expect(state.commands.at(-1)).toContain('find "/t/runs/moss/my-run-1/export" -maxdepth 1')
    state.version = { id: 'v3', hostId: 'gone', path: '/t' } as TrainerVersion
    expect(await collectTrainerArtifact(job())).toBeNull()
    expect(registerTrainedAdapter).not.toHaveBeenCalled()
  })
})
