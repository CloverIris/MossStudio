import type { JobRecord } from '@shared/types'
import { resolveCanvasAdapters } from './adapterResolution'
import { listControlAdapters } from './controlAdapters'
import { getEngineFeatures } from './engineFeatures'
import { galleryRoots } from './gallery'
import { pickJobInputs, validateJobInputs } from './jobInputs'
import { PROJECT_ID_PATTERN, projectAssetsDir } from './projects'
import { getSettings } from './settings'
import { startEngineJob } from './supervisor'
import { assertGenerationAllowed } from '../update/gate'

const INPUT_KEYS = new Set(['initImage', 'mask', 'control', 'references', 'sampling'])

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/**
 * The one way a generation request from outside main (IPC, the local HTTP
 * backend the Studio and the LAN web UI post to) becomes a job: blocked while an
 * update is required (minimumVersion), then LoRA ids are
 * resolved to files, and image inputs are validated and canonicalized before
 * anything is queued.
 */
export async function startRequestedEngineJob(raw: Record<string, unknown>): Promise<JobRecord> {
  // Clients below the feed's minimumVersion must update first (必须更新).
  assertGenerationAllowed()
  const settings = getSettings()
  const hostId = text(raw['hostId'])
  const adapters = await resolveCanvasAdapters(settings, raw['adapters'], { hostId })
  const base = Object.fromEntries(Object.entries(raw).filter(([key]) => !INPUT_KEYS.has(key)))
  if (!Object.keys(pickJobInputs(raw)).length) return startEngineJob({ ...base, adapters } as never)

  const projectId = text(raw['projectId'])
  const imageRoots = await galleryRoots(settings)
  if (projectId && PROJECT_ID_PATTERN.test(projectId)) imageRoots.push(projectAssetsDir(projectId))
  const features = await getEngineFeatures({ deviceUuid: text(raw['deviceUuid']), hostId }).catch(() => null)
  const inputs = await validateJobInputs(raw, {
    imageRoots,
    controlAdapters: listControlAdapters(),
    features,
    remote: Boolean(hostId),
  })
  return startEngineJob({ ...base, ...inputs, adapters } as never)
}
