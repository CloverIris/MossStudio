import { posix } from 'node:path'

/**
 * Which paths to delete on an SSH host when the user removes some models.
 *
 * Several catalog entries live in the same downloaded repo folder (the SFT
 * main model, the shared text encoder, VAE and configuration are all in one
 * snapshot), so deleting "the snapshot" of one of them would delete the
 * others. Each entry owns only the paths its file patterns name:
 * `transformer/*` owns the `transformer` folder, `model_index.json` owns that
 * file. A path is never deleted while an entry that stays needs it, or
 * anything inside it; then only the files nobody keeps are removed one by one.
 * Pure: the caller lists the host's files and runs the steps.
 */

export interface RemoteEntryFiles {
  id: string
  /** Absolute folder the entry was found in (an HF snapshot or a plain repo folder). */
  base: string
  /** Catalog file patterns relative to `base`: `dir/*` or an exact file. Empty: the whole folder. */
  patterns: readonly string[]
}

export interface RemoteDeleteStep {
  path: string
  /** true: remove the folder and everything in it; false: remove one file. */
  recursive: boolean
}

export interface RemoteDeletePlan {
  steps: RemoteDeleteStep[]
  /** Paths left in place because an entry that stays still needs them. */
  kept: string[]
}

/** Paths (relative to the base) an entry owns. '' means the whole base folder (only when it lists no files). */
export function ownedPaths(patterns: readonly string[]): string[] {
  const listed = patterns.filter((pattern) => pattern.trim())
  if (!listed.length) return ['']
  // Patterns we cannot read safely own nothing, rather than the whole folder.
  const owned = listed
    .map((pattern) => pattern.trim().replace(/^\.?\//, ''))
    .filter(Boolean)
    .map((pattern) => (pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern))
    .filter((pattern) => pattern && !pattern.includes('*') && !pattern.split('/').includes('..'))
  return [...new Set(owned)]
}

const within = (parent: string, child: string): boolean => parent === '' || child === parent || child.startsWith(`${parent}/`)

export function planRemoteDelete(
  remove: readonly RemoteEntryFiles[],
  keep: readonly RemoteEntryFiles[],
  files: readonly string[],
): RemoteDeletePlan {
  const steps = new Map<string, RemoteDeleteStep>()
  const kept = new Set<string>()
  for (const entry of remove) {
    const protectedPaths = keep.filter((other) => other.base === entry.base).flatMap((other) => ownedPaths(other.patterns))
    for (const target of ownedPaths(entry.patterns)) {
      const absolute = target ? posix.join(entry.base, target) : entry.base
      // Inside (or equal to) something that stays: leave it entirely.
      if (protectedPaths.some((path) => within(path, target))) {
        kept.add(absolute)
        continue
      }
      const nested = protectedPaths.filter((path) => within(target, path))
      if (!nested.length) {
        steps.set(absolute, { path: absolute, recursive: true })
        continue
      }
      // Something that stays lives inside it: remove only the other files.
      kept.add(absolute)
      const prefix = `${entry.base}/`
      for (const file of files) {
        if (!file.startsWith(prefix)) continue
        const relative = file.slice(prefix.length)
        if (!within(target, relative) || nested.some((path) => within(path, relative))) continue
        steps.set(file, { path: file, recursive: false })
      }
    }
  }
  // A recursive step already covers anything inside it.
  const recursive = [...steps.values()].filter((step) => step.recursive).map((step) => step.path)
  const result = [...steps.values()].filter(
    (step) => !recursive.some((folder) => folder !== step.path && step.path.startsWith(`${folder}/`)),
  )
  return { steps: result, kept: [...kept] }
}

/** Every step must stay strictly inside its entry's folder, which must be strictly inside the models root. */
export function assertSafeSteps(steps: readonly RemoteDeleteStep[], root: string, bases: readonly string[]): void {
  const cleanRoot = root.replace(/\/+$/, '')
  for (const base of bases) {
    if (posix.normalize(base) !== base || !base.startsWith(`${cleanRoot}/`)) throw new Error('模型文件夹不在模型目录中，已取消删除')
  }
  for (const step of steps) {
    if (posix.normalize(step.path) !== step.path) throw new Error('删除路径无效，已取消删除')
    if (!bases.some((base) => step.path === base || step.path.startsWith(`${base}/`)))
      throw new Error('删除路径不在模型文件夹中，已取消删除')
  }
}
