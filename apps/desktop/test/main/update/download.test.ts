import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { downloadAsset, isAbortError } from '@main/update/download'
import { useTempDir } from '@test/helpers/tempDir'
import { sha256, startFileServer, type FileServer } from './helpers'

const temp = useTempDir('moss-dl-')
const body = randomBytes(256 * 1024)
const digest = sha256(body)
let server: FileServer

beforeEach(async () => {
  server = await startFileServer({ '/github/pkg.zip': { body }, '/mirror/pkg.zip': { body } })
})
afterEach(() => server.close())

const dest = () => join(temp(), 'staging', 'pkg.zip')
const options = (urls: string[]) => ({ urls, dest: dest(), sha256: digest, size: body.length, stallMs: 2000 })
const rangesFor = (path: string) => server.hits.filter((hit) => hit.path === path).map((hit) => hit.headers['range'] ?? null)

describe('downloadAsset', () => {
  it('downloads, checks sha256 and reports progress', async () => {
    const progress: number[] = []
    await expect(downloadAsset({ ...options([server.url('/github/pkg.zip')]), onProgress: (bytes) => progress.push(bytes) })).resolves.toBe(dest())
    expect(readFileSync(dest()).equals(body)).toBe(true)
    expect(existsSync(`${dest()}.part`)).toBe(false)
    expect(progress.at(-1)).toBe(body.length)
  })

  it('resumes after a restart with HTTP Range from the bytes already on disk', async () => {
    server.routes.set('/github/pkg.zip', { body, cutAfter: 100_000 })
    await expect(downloadAsset({ ...options([server.url('/github/pkg.zip')]), rounds: 1 })).rejects.toThrow('下载更新失败')
    const kept = statSync(`${dest()}.part`).size
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(body.length)
    // "Restart": a new call with a healthy server continues from `kept`.
    server.routes.set('/github/pkg.zip', { body })
    await downloadAsset(options([server.url('/github/pkg.zip')]))
    expect(rangesFor('/github/pkg.zip').at(-1)).toBe(`bytes=${kept}-`)
    expect(readFileSync(dest()).equals(body)).toBe(true)
  })

  it('continues on the next mirror from where GitHub stopped, keeping the bytes', async () => {
    server.routes.set('/github/pkg.zip', { body, cutAfter: 64 * 1024 })
    await downloadAsset(options([server.url('/github/pkg.zip'), server.url('/mirror/pkg.zip')]))
    const range = rangesFor('/mirror/pkg.zip')[0]
    expect(range).toMatch(/^bytes=\d+-$/)
    expect(Number(/\d+/.exec(String(range))![0])).toBeGreaterThan(0)
    expect(readFileSync(dest()).equals(body)).toBe(true)
  })

  it('starts over when a server ignores Range', async () => {
    server.routes.set('/github/pkg.zip', { body, cutAfter: 50_000 })
    await expect(downloadAsset({ ...options([server.url('/github/pkg.zip')]), rounds: 1 })).rejects.toThrow()
    server.routes.set('/github/pkg.zip', { body, noRange: true })
    await downloadAsset(options([server.url('/github/pkg.zip')]))
    expect(readFileSync(dest()).equals(body)).toBe(true)
  })

  it('discards wrong bytes from a bad mirror and uses the next transport', async () => {
    server.routes.set('/mirror/pkg.zip', { body: randomBytes(body.length) })
    await downloadAsset(options([server.url('/mirror/pkg.zip'), server.url('/github/pkg.zip')]))
    expect(readFileSync(dest()).equals(body)).toBe(true)
    expect(rangesFor('/github/pkg.zip')[0]).toBeNull()
  })

  it('fails with every transport down, and on a body larger than declared', async () => {
    server.routes.set('/github/pkg.zip', { body, status: 503 })
    await expect(downloadAsset(options([server.url('/github/pkg.zip'), server.url('/missing.zip')]))).rejects.toThrow(/HTTP 503[\s\S]*HTTP 404/)
    server.routes.set('/github/pkg.zip', { body: Buffer.concat([body, Buffer.from('extra')]) })
    await expect(downloadAsset({ ...options([server.url('/github/pkg.zip')]), rounds: 1 })).rejects.toThrow('超过声明的大小')
  })

  it('skips the network when the finished file is already there', async () => {
    await downloadAsset(options([server.url('/github/pkg.zip')]))
    const hits = server.hits.length
    await downloadAsset(options([server.url('/github/pkg.zip')]))
    expect(server.hits.length).toBe(hits)
  })

  it('can be canceled, keeping the partial bytes for later', async () => {
    const controller = new AbortController()
    server.routes.set('/github/pkg.zip', { body, cutAfter: 32 * 1024 })
    const run = downloadAsset({
      ...options([server.url('/github/pkg.zip')]),
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })
    const error = await run.catch((caught: unknown) => caught)
    expect(isAbortError(error)).toBe(true)
    expect(existsSync(dest())).toBe(false)
  })
})
