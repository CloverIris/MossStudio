import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LaunchCase } from '@shared/types'
import { paths } from '../lib/paths'
import { getInstance } from './instances'

const FILE = () => join(paths.root(), 'cases.json')
let cases: LaunchCase[] | null = null

interface StoredCase extends Partial<LaunchCase> {
  backend?: unknown
  port?: unknown
  extraArgs?: unknown
}

function migrate(stored: StoredCase): LaunchCase | null {
  if (!stored.id || !stored.instanceId) return null
  // Gradio is retired; every Case now belongs to MossStudio.
  const workspace = 'clover' as const
  const now = new Date().toISOString()
  return {
    id: stored.id,
    name: typeof stored.name === 'string' && stored.name.trim() ? stored.name : stored.instanceId,
    instanceId: stored.instanceId,
    workspace,
    deviceId: typeof stored.deviceId === 'string' ? stored.deviceId : 'mps',
    profile: stored.profile === 'dmd8' ? 'dmd8' : 'base',
    createdAt: typeof stored.createdAt === 'string' ? stored.createdAt : now,
    lastUsedAt: typeof stored.lastUsedAt === 'string' ? stored.lastUsedAt : undefined,
  }
}

function ensure(): LaunchCase[] {
  if (cases) return cases
  try {
    if (!existsSync(FILE())) {
      cases = []
      return cases
    }
    const parsed = JSON.parse(readFileSync(FILE(), 'utf8')) as StoredCase[]
    const migrated = Array.isArray(parsed) ? parsed.map(migrate).filter((item): item is LaunchCase => item !== null) : []
    cases = migrated
    // Rewrite once so old `backend`/`port`/`extraArgs` fields do not linger.
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
    cases = []
  }
  return cases
}

function persist(): void {
  try {
    writeFileSync(FILE(), JSON.stringify(ensure(), null, 2), 'utf8')
  } catch {
    // best effort
  }
}

export function listCases(): LaunchCase[] {
  return ensure()
    .slice()
    .sort((a, b) => (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt))
}

export async function saveCase(input: Omit<LaunchCase, 'id' | 'createdAt' | 'lastUsedAt'> & { id?: string }): Promise<LaunchCase> {
  const instance = await getInstance(input.instanceId)
  if (!instance) throw new Error('实例不存在')
  const current = ensure()
  const existing = input.id ? current.find((item) => item.id === input.id) : undefined
  const now = new Date().toISOString()
  if (existing) {
    Object.assign(existing, {
      name: input.name?.trim() || existing.name,
      instanceId: input.instanceId,
      workspace: 'clover',
      deviceId: input.deviceId,
      profile: input.profile,
      lastUsedAt: now,
    })
    persist()
    return { ...existing }
  }
  const created: LaunchCase = {
    id: `case-${randomUUID().slice(0, 8)}`,
    name: input.name?.trim() || `${instance.name} · MossStudio`,
    instanceId: input.instanceId,
    workspace: 'clover',
    deviceId: input.deviceId,
    profile: input.profile,
    createdAt: now,
    lastUsedAt: now,
  }
  cases = [created, ...current]
  persist()
  return { ...created }
}

export function removeCase(id: string): void {
  cases = ensure().filter((item) => item.id !== id)
  persist()
}
