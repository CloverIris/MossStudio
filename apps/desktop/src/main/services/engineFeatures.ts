import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EngineFeatures } from '@shared/types'
import { engineFeaturesOf, protocolCompatible, type EngineHello } from '@shared/engineProtocol'
import { probeEngine } from '../lib/probeEngine'
import { resolveServerPath, runningEngineHello } from './mossInfer'
import { remoteEngineHello } from './remoteEngine'
import { getSettings } from './settings'
import { getTrainingHost } from './trainingHosts'

/**
 * What the engine a job would run on can do (engine:features). Answered from a
 * hello the app already has: the running moss-server's, or one probe per
 * engine binary (cached until the binary changes), never a new server per call.
 */

/** A failed probe is retried after this long, so a broken engine is not probed on every question. */
const FAILURE_TTL_MS = 30_000

let localCache: { fingerprint: string; at: number; hello: EngineHello | null } | null = null
let localPending: { fingerprint: string; promise: Promise<EngineHello | null> } | null = null

function fingerprintOf(path: string): string | null {
  try {
    return `${resolve(path)}:${statSync(path).mtimeMs}`
  } catch {
    return null
  }
}

async function localHello(deviceUuid?: string): Promise<EngineHello | null> {
  const running = runningEngineHello(deviceUuid)
  if (running) return running
  const serverPath = resolveServerPath(getSettings())
  if (!serverPath || !existsSync(serverPath)) return null
  const fingerprint = fingerprintOf(serverPath)
  if (!fingerprint) return null
  if (localCache?.fingerprint === fingerprint && (localCache.hello || Date.now() - localCache.at < FAILURE_TTL_MS)) {
    return localCache.hello
  }
  if (localPending?.fingerprint === fingerprint) return localPending.promise
  const promise = probeEngine(serverPath).catch(() => null)
  localPending = { fingerprint, promise }
  try {
    const hello = await promise
    localCache = { fingerprint, at: Date.now(), hello }
    return hello
  } finally {
    if (localPending?.promise === promise) localPending = null
  }
}

export async function getEngineFeatures(target: { deviceUuid?: string; hostId?: string } = {}): Promise<EngineFeatures | null> {
  if (target.hostId) {
    const host = getTrainingHost(getSettings(), target.hostId)
    if (!host || host.kind !== 'ssh') return null
    const hello = await remoteEngineHello(host)
    if (!hello || !protocolCompatible(hello)) return null
    // Input pictures are uploaded to the host; control adapters and live
    // previews are not carried over SSH yet.
    return { ...engineFeaturesOf(hello), control: false, preview: false }
  }
  const hello = await localHello(target.deviceUuid)
  if (!hello || !protocolCompatible(hello)) return null
  return engineFeaturesOf(hello)
}
