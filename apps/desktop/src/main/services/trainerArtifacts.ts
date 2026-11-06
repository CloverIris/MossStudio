import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { JobRecord, Settings, TrainerVersion } from '@shared/types'
import { paths } from '../lib/paths'
import { getSettings } from './settings'
import { findTrainerVersion } from './trainers'
import { getTrainingHost } from './trainingHosts'
import { remoteAbsolute, scpFrom, sshExec } from './ssh'
import { registerTrainedAdapter } from './models'

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-')
}

async function localSource(version: TrainerVersion, runName: string): Promise<string | null> {
  const candidates = [
    join(version.path, 'exports', `${runName}.safetensors`),
    join(version.path, 'runs', 'moss', runName, 'export', `${runName}.safetensors`),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

async function remoteSource(settings: Settings, version: TrainerVersion, runName: string): Promise<string | null> {
  const host = getTrainingHost(settings, version.hostId)
  if (!host || host.kind !== 'ssh') return null
  const base = await remoteAbsolute(host, version.path)
  const candidates = [`${base}/exports/${runName}.safetensors`, `${base}/runs/moss/${runName}/export/${runName}.safetensors`]
  for (const candidate of candidates) {
    const check = await sshExec(host, `test -f ${JSON.stringify(candidate)}`, 20_000)
    if (check.code === 0) return candidate
  }
  const found = await sshExec(
    host,
    `find ${JSON.stringify(`${base}/runs/moss/${runName}/export`)} -maxdepth 1 -name '*.safetensors' -print 2>/dev/null | head -1`,
    20_000,
  )
  return found.stdout.trim() || null
}

export async function collectTrainerArtifact(job: JobRecord): Promise<string | null> {
  if (job.kind !== 'training' || job.state !== 'succeeded' || !job.trainerVersionId || !job.trainerRunName) return null
  const settings = getSettings()
  const version = await findTrainerVersion(settings, job.trainerVersionId)
  if (!version) return null
  const runName = safeName(job.trainerRunName)
  const remote = version.hostId !== 'local'
  const source = remote ? await remoteSource(settings, version, runName) : await localSource(version, runName)
  if (!source) return null

  let local = source
  if (remote) {
    const host = getTrainingHost(settings, version.hostId)
    if (!host || host.kind !== 'ssh') return null
    const dir = join(paths.cache(), 'trainer-artifacts')
    await mkdir(dir, { recursive: true })
    const target = join(dir, `${safeName(version.id)}-${runName}.safetensors`)
    const result = await scpFrom(host, source, target)
    if (result.code !== 0) return null
    local = target
  }

  const adapter = await registerTrainedAdapter(settings, {
    id: `trained-${runName}`,
    name: `${runName} · Kohaku Trainer`,
    sourcePath: local,
    kind: job.trainerAlgo === 'full' ? 'lora' : 'lora',
    base: job.trainerWeights,
    license: 'local',
  })
  if (remote && local !== source) await rm(local, { force: true }).catch(() => undefined)
  return adapter.id
}
