import { statSync } from 'node:fs'
import type { DitPrecision, TextEncoderPrecision, WeightPrecisions } from '@shared/gpuProfile'
import { requestEngineOnce } from '../lib/probeEngine'
import { localServerPath } from './engineInstalls'
import { requestRunningEngine } from './mossInfer'

/**
 * What a job's DiT and text encoder weights are (bf16, INT8, INT4…), which
 * decides the tier the engine runs them at. A bundle folder's own components
 * are bf16; a component file is asked of the engine (`inspect`, header only,
 * no GPU), once per file version.
 */

const DIT: readonly DitPrecision[] = ['bf16', 'int8', 'w4a4']
const TEXT_ENCODER: readonly TextEncoderPrecision[] = ['bf16', 'int8', 'w4a8']

const cache = new Map<string, string | null>()

/**
 * Asks the job's own engine: its GPU's running moss-server (inspect runs beside
 * a generation), else, or when that one fails, a short-lived server of the
 * GPU's package.
 */
async function inspect(path: string, deviceUuid: string | undefined, serverPath: string): Promise<Record<string, unknown>> {
  const running = deviceUuid ? requestRunningEngine('inspect', { path }, 15_000, deviceUuid) : null
  if (running) {
    try {
      return await running
    } catch {
      // A busy or older server: the package's own one-shot server answers instead.
    }
  }
  return (await requestEngineOnce(serverPath, 'inspect', { path }, { timeoutMs: 30_000 })).result
}

async function filePrecision(path: string, kind: 'dit' | 'text_encoder', deviceUuid: string | undefined): Promise<string | null> {
  const serverPath = localServerPath(deviceUuid)
  if (!serverPath) return null
  let key: string
  try {
    const info = statSync(path)
    // The engine is part of the key: an update may load a file the old one could not.
    key = `${serverPath}:${kind}:${path}:${info.size}:${info.mtimeMs}`
  } catch {
    return null
  }
  if (cache.has(key)) return cache.get(key)!
  let precision: string | null = null
  try {
    const report = await inspect(path, deviceUuid, serverPath)
    // A file of another kind, or one the engine cannot load: its load reports that.
    if (report['kind'] === kind && report['loadable'] !== false && typeof report['precision'] === 'string') {
      precision = report['precision']
    }
  } catch {
    // An engine without inspect, or a failed probe: not known, and not remembered.
    return null
  }
  cache.set(key, precision)
  return precision
}

export async function jobWeightPrecisions(
  files: { ditFile?: string; textEncoderFile?: string },
  deviceUuid?: string,
): Promise<WeightPrecisions> {
  // One after the other: with no engine running, each asks a short-lived server of its own.
  const dit = files.ditFile ? await filePrecision(files.ditFile, 'dit', deviceUuid) : 'bf16'
  const textEncoder = files.textEncoderFile ? await filePrecision(files.textEncoderFile, 'text_encoder', deviceUuid) : 'bf16'
  return {
    dit: DIT.includes(dit as DitPrecision) ? (dit as DitPrecision) : null,
    textEncoder: TEXT_ENCODER.includes(textEncoder as TextEncoderPrecision) ? (textEncoder as TextEncoderPrecision) : null,
  }
}
