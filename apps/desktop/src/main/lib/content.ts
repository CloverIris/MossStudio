import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Folder holding the content files the app ships with: models.json (model catalog)
 * and rules.json (diagnostic rules). Source: apps/desktop/resources/. Packaged builds
 * carry them as extra resources, i.e. directly in process.resourcesPath.
 * Returns null when neither file is there (a broken package), so readers fall back.
 */
export function contentDir(): string | null {
  const dir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  return existsSync(join(dir, 'models.json')) || existsSync(join(dir, 'rules.json')) ? dir : null
}

/**
 * Where a models.json that wins over the catalog on `main` lives: the source tree, in development
 * only, so an edit shows at once. A packaged app's copy is its fallback, never an override, or it
 * would never see a model added after its release.
 */
export function catalogOverrideDir(): string | null {
  return app.isPackaged ? null : contentDir()
}
