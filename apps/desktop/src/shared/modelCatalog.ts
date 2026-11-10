/**
 * The model catalog file (apps/desktop/resources/models.json) as it is written, and the rules a
 * copy must meet before the app uses it. Released apps download this file from `main`, so a
 * model added to it reaches them without a release (docs/how-to/add-a-model.md).
 */
import { z } from 'zod'
import { compareSemver } from './update'

/**
 * The newest catalog layout this app reads. Raise it only when an older app would misread the
 * file; such an app keeps the catalog it has instead. New optional fields do not raise it.
 */
export const CATALOG_SCHEMA_VERSION = 3

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const semver = z.string().regex(SEMVER, 'not a version like 2.1.0 or 2.1.0-beta.2')
/** A commit pinned by its full hash, or a branch the app follows. */
const revision = z.string().regex(/^(?:[0-9a-f]{40}|main)$/, 'not a 40-character commit hash or "main"')
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'not a lowercase id')
const text = z.string().trim().min(1)

const model = z.object({
  id,
  name: text,
  choice: text.optional(),
  variant: z.array(text).optional(),
  provider: z.literal('hf'),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'not an owner/name repository'),
  revision,
  role: z.enum(['dit', 'text_encoder', 'vae', 'support', 'full']),
  precision: text,
  format: z.enum(['diffusers', 'comfyui']).optional(),
  family: text.optional(),
  subfolder: z.string().optional(),
  size_bytes: z.number().int().positive(),
  files: z.array(text).min(1),
  license: text,
  tags: z.array(text).optional(),
  notes: z.string().optional(),
  preview: z.string().optional(),
  min_app_version: semver.optional(),
})

const bundle = z.object({
  id,
  name: text,
  variant: z.array(text).optional(),
  description: z.string(),
  components: z.object({ dit: id, textEncoder: id, vae: id }),
  support: id,
  recommended: z.boolean().optional(),
  certified: z.boolean().optional(),
  tier: z.enum(['high', 'turbo']).optional(),
  requires: z.object({ computeCapability: z.object({ major: z.number().int(), minor: z.number().int() }), label: text }).optional(),
  recommendedFor: z.literal('limited-vram').optional(),
  defaults: z.object({ steps: z.number().int().positive().optional(), cfg: z.number().nonnegative().optional() }).optional(),
  min_app_version: semver.optional(),
})

const adapter = z.object({
  id,
  name: text,
  provider: z.literal('hf'),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'not an owner/name repository'),
  revision,
  kind: z.enum(['lora', 'lycoris', 'dmd']),
  base: id.optional(),
  license: text,
  files: z.array(text).min(1),
  size_bytes: z.number().int().positive(),
  size_estimated: z.boolean().optional(),
  requires_profile: text.optional(),
  tags: z.array(text).optional(),
  notes: z.string().optional(),
  min_app_version: semver.optional(),
})

/** Unknown fields pass: a field added for newer apps must not make older ones reject the file. */
export const catalogFileSchema = z.object({
  schema_version: z.number().int().positive(),
  updated_at: z.iso.datetime().optional(),
  models: z.array(model),
  bundles: z.array(bundle).optional(),
  single_file_bundles: z.array(bundle).optional(),
  adapters: z.array(adapter).optional(),
})

export type CatalogFile = z.infer<typeof catalogFileSchema>

const ROLE_OF = { dit: 'dit', textEncoder: 'text_encoder', vae: 'vae' } as const

/**
 * Everything wrong with a catalog file, as one line each; empty when the app can use it.
 * Beyond its shape: ids are unique, and every bundle names parts that exist in the role it uses them.
 */
export function catalogProblems(raw: unknown): string[] {
  const parsed = catalogFileSchema.safeParse(raw)
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join('.') || '(file)'}: ${issue.message}`)
  const file = parsed.data
  const problems: string[] = []
  if (file.schema_version > CATALOG_SCHEMA_VERSION) {
    problems.push(`schema_version ${file.schema_version} is newer than this app reads (${CATALOG_SCHEMA_VERSION})`)
  }
  const duplicates = (list: Array<{ id: string }>, where: string): void => {
    const seen = new Set<string>()
    for (const item of list) {
      if (seen.has(item.id)) problems.push(`${where}: "${item.id}" appears twice`)
      seen.add(item.id)
    }
  }
  duplicates(file.models, 'models')
  duplicates([...(file.bundles ?? []), ...(file.single_file_bundles ?? [])], 'bundles')
  duplicates(file.adapters ?? [], 'adapters')
  const models = new Map(file.models.map((item) => [item.id, item]))
  for (const item of [...(file.bundles ?? []), ...(file.single_file_bundles ?? [])]) {
    for (const [slot, role] of Object.entries(ROLE_OF) as Array<[keyof typeof ROLE_OF, string]>) {
      const part = models.get(item.components[slot])
      if (!part) problems.push(`bundle "${item.id}": ${slot} "${item.components[slot]}" is not in models`)
      else if (part.role !== role) problems.push(`bundle "${item.id}": ${slot} "${part.id}" has role ${part.role}, not ${role}`)
    }
    const support = models.get(item.support)
    if (!support) problems.push(`bundle "${item.id}": support "${item.support}" is not in models`)
    else if (support.role !== 'support') problems.push(`bundle "${item.id}": support "${support.id}" has role ${support.role}, not support`)
  }
  return problems
}

/**
 * Whether an app at `appVersion` may offer an entry that needs `minimum`. A prerelease of a
 * version counts as that version (a nightly of 2.1.0 has the code 2.1.0 ships), unless the
 * minimum names a prerelease itself.
 */
export function meetsMinimumVersion(appVersion: string, minimum: string | undefined): boolean {
  if (!minimum) return true
  const app = minimum.includes('-') ? appVersion : appVersion.replace(/[-+].*$/, '')
  return compareSemver(app, minimum) >= 0
}

interface Gated {
  id: string
  min_app_version?: string
}
interface GatedBundle extends Gated {
  components: { dit: string; textEncoder: string; vae: string }
  support: string
}

/**
 * The entries an app at `appVersion` can use: entries needing a newer app are left out, and so
 * is every bundle that names a part left out.
 */
export function entriesForApp<
  T extends {
    models: Gated[]
    bundles?: GatedBundle[]
    single_file_bundles?: GatedBundle[]
    adapters?: Gated[]
  },
>(catalog: T, appVersion: string): T {
  const fits = (item: Gated): boolean => meetsMinimumVersion(appVersion, item.min_app_version)
  const dropped = new Set(catalog.models.filter((item) => !fits(item)).map((item) => item.id))
  if (!dropped.size && [...(catalog.bundles ?? []), ...(catalog.single_file_bundles ?? []), ...(catalog.adapters ?? [])].every(fits)) {
    return catalog
  }
  const usable = (item: GatedBundle): boolean =>
    fits(item) && ![item.components.dit, item.components.textEncoder, item.components.vae, item.support].some((part) => dropped.has(part))
  return {
    ...catalog,
    models: catalog.models.filter(fits),
    ...(catalog.bundles && { bundles: catalog.bundles.filter(usable) }),
    ...(catalog.single_file_bundles && { single_file_bundles: catalog.single_file_bundles.filter(usable) }),
    ...(catalog.adapters && { adapters: catalog.adapters.filter(fits) }),
  }
}
