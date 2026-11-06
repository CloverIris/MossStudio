import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileSize, validateSnapshot, type ModelFile } from './modelFiles'

export async function resolveLegacyModelPath(dir: string): Promise<string | null> {
  try {
    if ((await fileSize(join(dir, 'model_index.json'))) >= 0) return dir
    const sha = (await readFile(join(dir, 'refs', 'main'), 'utf8')).trim()
    if (!/^[a-f0-9]{40,64}$/.test(sha)) return null
    return join(dir, 'snapshots', sha)
  } catch {
    return null
  }
}

export async function legacyModelReady(path: string): Promise<boolean> {
  try {
    const root = await resolveLegacyModelPath(path)
    if (!root) return false
    const files: ModelFile[] = []
    const walk = async (dir: string, prefix = ''): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix + entry.name
        if (entry.isDirectory()) await walk(join(dir, entry.name), `${rel}/`)
        else if (!rel.endsWith('.part')) files.push({ path: rel, size: await fileSize(join(dir, entry.name)), oid: null })
      }
    }
    await walk(root)
    for (const [role, folder] of [
      ['dit', 'transformer'],
      ['text_encoder', 'text_encoder'],
      ['vae', 'vae'],
      ['support', ''],
    ]) {
      if (!(await validateSnapshot(root, files, role!, folder))) return false
    }
    return true
  } catch {
    return false
  }
}
