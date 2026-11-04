/**
 * Shared fixtures for the models/* tests (not a test file itself): a fake
 * Hugging Face endpoint on 127.0.0.1, an on-disk catalog, and a way to lay out
 * an installed component exactly as models.ts writes it.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { ModelEntry, Settings } from '@shared/types'

export interface FakeRepo {
  sha: string
  files: Record<string, Buffer | string>
}

export interface FakeHf {
  base: string
  requests: string[]
  /** Return true when the hook handled the response itself. */
  intercept: ((req: IncomingMessage, res: ServerResponse, path: string) => boolean) | null
  close(): Promise<void>
}

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

export async function startFakeHf(repos: Record<string, FakeRepo>): Promise<FakeHf> {
  const fake: FakeHf = { base: '', requests: [], intercept: null, close: async () => undefined }
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    fake.requests.push(`${req.method} ${url.pathname}${req.headers.range ? ` ${req.headers.range}` : ''}`)
    const path = decodeURIComponent(url.pathname)
    if (fake.intercept?.(req, res, path)) return
    for (const [name, repo] of Object.entries(repos)) {
      if (path.startsWith(`/api/models/${name}/revision/`)) {
        res.end(JSON.stringify({ sha: repo.sha }))
        return
      }
      if (path === `/api/models/${name}/tree/${repo.sha}`) {
        res.end(JSON.stringify(Object.entries(repo.files).map(([file, body]) => ({
          type: 'file', path: file, size: Buffer.byteLength(body), lfs: { oid: sha256(body) },
        }))))
        return
      }
      const prefix = `/${name}/resolve/${repo.sha}/`
      if (path.startsWith(prefix)) {
        const body = repo.files[path.slice(prefix.length)]
        if (body === undefined) break
        const data = Buffer.from(body)
        const offset = Number(req.headers.range?.match(/\d+/)?.[0] ?? 0)
        if (offset) {
          res.writeHead(206, { 'content-range': `bytes ${offset}-${data.length - 1}/${data.length}` })
          res.end(data.subarray(offset))
        } else res.end(data)
        return
      }
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  fake.close = async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return fake
}

export function writeCatalog(dir: string, catalog: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'models.json'), JSON.stringify(catalog))
}

/** A diffusers VAE component: config + one weights file under `vae/`. */
export const vaeFiles = (tag = 'vae'): Record<string, string> => ({
  'vae/config.json': `{"tag":"${tag}"}`,
  'vae/diffusion_pytorch_model.safetensors': `${tag}-weights-0123456789`,
})

export function rawModel(patch: Record<string, unknown>): Record<string, unknown> {
  return {
    name: String(patch['id']),
    provider: 'hf',
    revision: 'main',
    precision: 'bf16',
    license: 'apache-2.0',
    ...patch,
  }
}

export function cacheDirFor(modelsRoot: string, role: ModelEntry['role'], repo: string): string {
  const folder = { full: '', dit: 'moss', text_encoder: 'text-encoder', vae: 'vae', support: 'support' }[role]
  return join(modelsRoot, folder, 'hf', 'hub', `models--${repo.replace('/', '--')}`)
}

/** Lay out an installed component the way runModelDownload leaves it. */
export function installOnDisk(
  modelsRoot: string,
  model: { id: string; repo: string; role: ModelEntry['role']; revision?: string },
  sha: string,
  files: Record<string, string>,
  options: { owned?: boolean } = {},
): string {
  const dir = cacheDirFor(modelsRoot, model.role, model.repo)
  const entries = Object.entries(files).map(([path, body]) => ({ path, size: Buffer.byteLength(body), oid: sha256(body) }))
  for (const entry of entries) {
    const blob = join(dir, 'blobs', entry.oid)
    const target = join(dir, 'snapshots', sha, entry.path)
    mkdirSync(join(blob, '..'), { recursive: true })
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(blob, files[entry.path]!)
    writeFileSync(target, files[entry.path]!)
  }
  mkdirSync(join(dir, 'refs'), { recursive: true })
  writeFileSync(join(dir, 'refs', model.revision ?? 'main'), sha)
  writeFileSync(
    join(dir, `.clover-${model.id}.json`),
    JSON.stringify({
      version: 2, id: model.id, repo: model.repo, revision: model.revision ?? 'main', sha, entries,
      owned: options.owned === false ? [] : entries.map((e) => e.path),
    }),
  )
  return dir
}

export function testSettings(defaults: Settings, patch: Partial<Settings>): Settings {
  return { ...defaults, modelDirectories: { ...defaults.modelDirectories }, ...patch }
}
