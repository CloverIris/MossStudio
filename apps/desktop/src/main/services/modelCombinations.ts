import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { legacyLocalCombination } from '@shared/modelCombos'
import type { ModelCombination, ModelEntry } from '@shared/types'
import { paths } from '../lib/paths'

/** 自己组合: the combinations the person saved, in `<data root>/model-combinations.json`. */

function storeFile(): string {
  return join(paths.root(), 'model-combinations.json')
}

function isCombination(value: unknown): value is ModelCombination {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ModelCombination>
  const parts = item.components
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.createdAt === 'string' &&
    Boolean(parts) &&
    typeof parts?.dit === 'string' &&
    typeof parts.textEncoder === 'string' &&
    typeof parts.vae === 'string'
  )
}

function write(entries: ModelCombination[]): void {
  const file = storeFile()
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(entries, null, 2), 'utf8')
  renameSync(temporary, file)
}

export function listCombinations(): ModelCombination[] {
  try {
    const raw = JSON.parse(readFileSync(storeFile(), 'utf8')) as unknown
    return Array.isArray(raw) ? raw.filter(isCombination) : []
  } catch {
    return []
  }
}

/**
 * The saved combinations, for the catalog. The first time, the scanned-files
 * model older versions made by themselves is kept as one, under its old id.
 */
export function catalogCombinations(models: readonly ModelEntry[]): ModelCombination[] {
  if (existsSync(storeFile())) return listCombinations()
  const legacy = legacyLocalCombination(models)
  if (!legacy) return []
  write([legacy])
  return [legacy]
}

export function saveCombination(input: { id?: string; name: string; components: ModelCombination['components'] }): ModelCombination {
  const entries = listCombinations()
  const existing = input.id ? entries.find((entry) => entry.id === input.id) : undefined
  const combination: ModelCombination = {
    id: existing?.id ?? `combo-${randomUUID().slice(0, 8)}`,
    name: input.name.trim(),
    components: { dit: input.components.dit, textEncoder: input.components.textEncoder, vae: input.components.vae },
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  }
  write(existing ? entries.map((entry) => (entry.id === existing.id ? combination : entry)) : [...entries, combination])
  return combination
}

export function deleteCombination(id: string): void {
  const entries = listCombinations()
  write(entries.filter((entry) => entry.id !== id))
}
