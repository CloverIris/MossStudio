import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LaunchRow } from '@shared/types'
import { paths } from '../lib/paths'

const FILE = () => join(paths.root(), 'launch-queue.json')
const STATES = new Set<LaunchRow['state']>(['queued', 'starting', 'running', 'stopped', 'failed'])
let rows: LaunchRow[] | null = null

interface StoredRow extends Partial<LaunchRow> {
  backend?: unknown
  port?: unknown
  extraArgs?: unknown
}

function migrate(stored: StoredRow): LaunchRow | null {
  if (!stored.id || !stored.instanceId) return null
  // Gradio launch metadata is discarded; keep only MossStudio queue state.
  const now = new Date().toISOString()
  return {
    id: stored.id,
    caseId: typeof stored.caseId === 'string' ? stored.caseId : undefined,
    caseName: typeof stored.caseName === 'string' && stored.caseName ? stored.caseName : stored.instanceId,
    instanceId: stored.instanceId,
    instanceName: typeof stored.instanceName === 'string' ? stored.instanceName : stored.instanceId,
    workspace: 'clover',
    deviceId: typeof stored.deviceId === 'string' ? stored.deviceId : 'mps',
    profile: stored.profile === 'dmd8' ? 'dmd8' : 'base',
    jobId: typeof stored.jobId === 'string' ? stored.jobId : undefined,
    state: STATES.has(stored.state as LaunchRow['state']) ? (stored.state as LaunchRow['state']) : 'failed',
    queuedAt: typeof stored.queuedAt === 'string' ? stored.queuedAt : now,
    startedAt: typeof stored.startedAt === 'string' ? stored.startedAt : undefined,
    error: typeof stored.error === 'string' ? stored.error : undefined,
  }
}

function ensure(): LaunchRow[] {
  if (rows) return rows
  try {
    if (!existsSync(FILE())) {
      rows = []
      return rows
    }
    const parsed = JSON.parse(readFileSync(FILE(), 'utf8')) as StoredRow[]
    rows = Array.isArray(parsed) ? parsed.map(migrate).filter((item): item is LaunchRow => item !== null) : []
    if (
      Array.isArray(parsed) &&
      parsed.some(
        (item) =>
          'backend' in item ||
          'port' in item ||
          'extraArgs' in item ||
          'gradio' in item ||
          (item as { workspace?: unknown }).workspace === 'official',
      )
    ) {
      persist()
    }
  } catch {
    rows = []
  }
  // A restarted process cannot resume a running inference job. Keep queued rows;
  // mark interrupted starting/running rows failed so the UI does not imply progress.
  let changed = false
  for (const row of rows) {
    if (row.state === 'starting' || row.state === 'running') {
      row.state = 'failed'
      row.error = '应用重启，任务已中断'
      changed = true
    }
  }
  if (changed) persist()
  return rows
}

function persist(): void {
  try {
    writeFileSync(FILE(), JSON.stringify(ensure(), null, 2), 'utf8')
  } catch {
    // best effort
  }
}

export function listLaunchRows(): LaunchRow[] {
  return ensure()
    .slice()
    .sort((a, b) => (b.startedAt ?? b.queuedAt).localeCompare(a.startedAt ?? a.queuedAt))
}

export function upsertLaunchRow(row: LaunchRow): LaunchRow {
  const current = ensure()
  rows = [row, ...current.filter((item) => item.id !== row.id)]
  persist()
  return { ...row }
}

export function removeLaunchRow(id: string): void {
  rows = ensure().filter((row) => row.id !== id)
  persist()
}
