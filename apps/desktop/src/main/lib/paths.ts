import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

let dataRootOverride: string | null = null
let engineRootOverride: string | null = null

/**
 * Application data lives next to the executable when packaged (portable installs
 * keep everything in one folder). Dev keeps using the repo's .dev-data, and
 * MOSSSTUDIO_DATA wins over everything for tests and relocated installs.
 */
export function root(): string {
  const env = process.env['MOSSSTUDIO_DATA']?.trim()
  if (env) return resolve(env)
  if (dataRootOverride) return resolve(dataRootOverride)
  if (!app.isPackaged) return app.getPath('userData')
  return join(dirname(app.getPath('exe')), 'data')
}

export function setDataRoot(next: string | null): void {
  dataRootOverride = next
}

/** Engine builds live under the data root unless the user points somewhere else. */
export function engineRoot(): string {
  return engineRootOverride ? resolve(engineRootOverride) : join(root(), 'mossinfer')
}

export function setEngineRoot(next: string | null): void {
  engineRootOverride = next
}

export function modelsRoot(custom?: string | null): string {
  return custom ? resolve(custom) : join(root(), 'models')
}

export const paths = {
  root,
  engineRoot,
  settings: () => join(root(), 'settings.json'),
  announcements: () => join(root(), 'announcements.json'),
  git: () => join(root(), 'git'),
  mirror: () => join(root(), 'git', 'moss-image.git'),
  mirrorForSource: (source: string) =>
    join(root(), 'git', `moss-image-${createHash('sha1').update(source).digest('hex').slice(0, 12)}.git`),
  instances: () => join(root(), 'instances'),
  instance: (id: string) => join(root(), 'instances', id),
  runtimes: () => join(root(), 'runtimes'),
  runtime: (id: string) => join(root(), 'runtimes', id),
  managedPython: () => join(root(), 'runtimes', 'python'),
  models: (custom?: string | null) => modelsRoot(custom),
  hub: (custom?: string | null) => join(modelsRoot(custom), 'hf', 'hub'),
  adapters: (custom?: string | null) => join(modelsRoot(custom), 'adapters'),
  modelImports: (custom?: string | null) => join(modelsRoot(custom), 'imports'),
  downloads: () => join(root(), 'downloads'),
  outputs: () => join(root(), 'outputs'),
  cache: () => join(root(), 'cache'),
  mossinfer: () => engineRoot(),
  logs: () => join(root(), 'logs'),
  trainerRoot: (custom?: string | null) => (custom ? resolve(custom) : join(root(), 'trainer')),
  trainerGit: () => join(root(), 'trainer', 'git'),
  trainerMirror: () => join(root(), 'trainer', 'git', 'kohaku-trainer.git'),
  trainerVersions: () => join(root(), 'trainer', 'versions'),
  trainerVersion: (id: string) => join(root(), 'trainer', 'versions', id),
  trainerRuntimes: () => join(root(), 'trainer', 'runtimes'),
  trainerRuntime: (id: string) => join(root(), 'trainer', 'runtimes', id),
}

export function ensureDirs(customModelsRoot?: string | null): void {
  const dirs = [
    paths.root(),
    paths.git(),
    paths.instances(),
    paths.runtimes(),
    paths.managedPython(),
    paths.models(customModelsRoot),
    paths.hub(customModelsRoot),
    paths.adapters(customModelsRoot),
    paths.modelImports(customModelsRoot),
    paths.downloads(),
    paths.cache(),
    paths.logs(),
    paths.mossinfer(),
    paths.trainerGit(),
    paths.trainerVersions(),
    paths.trainerRuntimes(),
  ]
  for (const dir of dirs) mkdirSync(dir, { recursive: true })
}

export function isInside(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
