// The app's own contract modules (zod schemas in shared/install.ts, trusted keys in
// shared/updateKeys.ts), loaded straight from source with Node's TypeScript type stripping
// (Node >= 22.18), so the pipeline validates with exactly the schemas clients parse with.
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { DESKTOP_DIR } from './cli.mjs'

async function load(file) {
  if (!process.features?.typescript) {
    throw new Error(`Node ${process.version} cannot load ${file}: needs TypeScript type stripping (Node >= 22.18)`)
  }
  return import(pathToFileURL(join(DESKTOP_DIR, 'src', 'shared', file)).href)
}

export function loadInstallContract() {
  return load('install.ts')
}

export async function loadProductionKeys() {
  const module = await load('updateKeys.ts')
  return [...module.PRODUCTION_UPDATE_KEYS]
}
