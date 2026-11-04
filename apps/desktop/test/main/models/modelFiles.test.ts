import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  downloadFile,
  fileSize,
  hashFile,
  materialize,
  matchesFile,
  resolveFiles,
  safePath,
  selectFiles,
  validateSnapshot,
  type ModelFile,
} from '@main/services/modelFiles'
import { useTempDir } from '@test/helpers/tempDir'

const payload = Buffer.from('verified-model-fixture-0123456789')
const file: ModelFile = {
  path: 'model.safetensors',
  size: payload.length,
  oid: createHash('sha256').update(payload).digest('hex'),
}
const sha = '1'.repeat(40)

const tempDir = useTempDir('mossstudio-model-files-')
let server: Server
let base = ''

beforeEach(async () => {
  server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

type Handler = (req: IncomingMessage, res: ServerResponse) => void
function serve(handler: Handler): void {
  server.on('request', handler)
}
function send(res: ServerResponse, body: string | Buffer, status = 200, headers: Record<string, string> = {}): void {
  res.writeHead(status, headers)
  res.end(body)
}
function rangeOffset(req: IncomingMessage): number {
  return Number(req.headers.range?.match(/\d+/)?.[0] ?? 0)
}
const noop = (): void => undefined
const signal = (): AbortSignal => new AbortController().signal

describe('downloadFile', () => {
  async function transfer(mode: '206' | '200' | '416', initial: Buffer | null, expectedRequests = 1): Promise<void> {
    const target = join(tempDir(), 'blob')
    if (initial) await writeFile(`${target}.part`, initial)
    let count = 0
    serve((req, res) => {
      count++
      const offset = rangeOffset(req)
      if (mode === '416' && count === 1) return send(res, '', 416)
      if (mode === '206')
        return send(res, payload.subarray(offset), 206, {
          'content-range': `bytes ${offset}-${payload.length - 1}/${payload.length}`,
        })
      send(res, payload)
    })
    await downloadFile(base, target, file, signal(), noop)
    expect(await readFile(target)).toEqual(payload)
    expect(count).toBe(expectedRequests)
    expect(existsSync(`${target}.part`)).toBe(false)
  }

  it('Range 206 resumes at the existing offset', () => transfer('206', payload.subarray(0, 8)))
  it('Range ignored with 200 replaces the partial file', () => transfer('200', payload.subarray(0, 8)))
  it('416 retries a fresh request', () => transfer('416', payload.subarray(0, 8), 2))
  it('oversized partial file starts over', () => transfer('200', Buffer.alloc(payload.length + 1)))
  it('downloads from scratch with no partial file', () => transfer('200', null))

  it('sends a Range header only when resuming and a bearer token when given', async () => {
    const target = join(tempDir(), 'blob')
    await writeFile(`${target}.part`, payload.subarray(0, 8))
    const seen: Array<{ range?: string; auth?: string }> = []
    serve((req, res) => {
      seen.push({ range: req.headers.range, auth: req.headers.authorization })
      const offset = rangeOffset(req)
      send(res, payload.subarray(offset), 206, {
        'content-range': `bytes ${offset}-${payload.length - 1}/${payload.length}`,
      })
    })
    await downloadFile(base, target, file, signal(), noop, { token: 'hf_secret' })
    expect(seen).toEqual([{ range: 'bytes=8-', auth: 'Bearer hf_secret' }])
  })

  it('a complete partial file is verified without a request', async () => {
    let count = 0
    serve((_, res) => { count++; send(res, payload) })
    await writeFile(join(tempDir(), 'blob.part'), payload)
    await downloadFile(base, join(tempDir(), 'blob'), file, signal(), noop)
    expect(await readFile(join(tempDir(), 'blob'))).toEqual(payload)
    expect(count).toBe(0)
  })

  it('a complete but corrupt partial file is discarded and downloaded again', async () => {
    let count = 0
    serve((req, res) => {
      count++
      expect(req.headers.range).toBeUndefined()
      send(res, payload)
    })
    await writeFile(join(tempDir(), 'blob.part'), Buffer.alloc(payload.length))
    await downloadFile(base, join(tempDir(), 'blob'), file, signal(), noop)
    expect(await readFile(join(tempDir(), 'blob'))).toEqual(payload)
    expect(count).toBe(1)
  })

  it('an already verified destination is reported done without touching the network', async () => {
    let count = 0
    serve((_, res) => { count++; send(res, payload) })
    const target = join(tempDir(), 'blob')
    await writeFile(target, payload)
    const events: Array<[number, boolean]> = []
    await downloadFile(base, target, file, signal(), (bytes, verifying) => events.push([bytes, verifying]))
    expect(count).toBe(0)
    expect(events).toEqual([[payload.length, true], [payload.length, false]])
  })

  it('corrupt same-size blob is repaired; shared writers download only once', async () => {
    const target = join(tempDir(), 'blob')
    await writeFile(target, Buffer.alloc(payload.length))
    let count = 0
    serve((_, res) => { count++; send(res, payload) })
    await Promise.all([1, 2, 3].map(() => downloadFile(base, target, file, signal(), noop)))
    expect(count).toBe(1)
    expect(await readFile(target)).toEqual(payload)
  })

  it('a file without a SHA256 oid (git sha1) is accepted on size alone', async () => {
    serve((_, res) => send(res, Buffer.alloc(payload.length, 7)))
    const target = join(tempDir(), 'blob')
    await downloadFile(base, target, { ...file, oid: 'a'.repeat(40) }, signal(), noop)
    expect((await stat(target)).size).toBe(payload.length)
  })

  it('incorrect Content-Range is rejected', async () => {
    await writeFile(join(tempDir(), 'blob.part'), payload.subarray(0, 8))
    serve((_, res) =>
      send(res, payload.subarray(8), 206, { 'content-range': `bytes 0-${payload.length - 1}/${payload.length}` }),
    )
    await expect(downloadFile(base, join(tempDir(), 'blob'), file, signal(), noop)).rejects.toThrow(/续传范围/)
  })

  it('a 206 without Content-Range is rejected', async () => {
    await writeFile(join(tempDir(), 'blob.part'), payload.subarray(0, 8))
    serve((_, res) => send(res, payload.subarray(8), 206))
    await expect(downloadFile(base, join(tempDir(), 'blob'), file, signal(), noop)).rejects.toThrow(/续传范围/)
  })

  it('non-200/206 statuses surface as HTTP errors', async () => {
    serve((_, res) => send(res, 'nope', 503))
    await expect(downloadFile(base, join(tempDir(), 'blob'), file, signal(), noop)).rejects.toThrow('下载 HTTP 503')
  })

  it('a response larger than the expected size is aborted', async () => {
    serve((_, res) => send(res, Buffer.concat([payload, Buffer.from('extra-bytes')])))
    const target = join(tempDir(), 'blob')
    await expect(downloadFile(base, target, file, signal(), noop)).rejects.toThrow(/超过预期大小/)
    expect(existsSync(target)).toBe(false)
  })

  it('wrong SHA and truncated responses never become completed files', async () => {
    serve((req, res) => send(res, req.url === '/short' ? payload.subarray(0, 5) : Buffer.alloc(payload.length)))
    for (const route of ['/short', '/bad']) {
      const target = join(tempDir(), route.slice(1))
      await expect(downloadFile(base + route, target, file, signal(), noop)).rejects.toThrow(/校验失败/)
      expect(existsSync(target)).toBe(false)
    }
    // A truncated download is kept for resumption; a full-size corrupt one is discarded.
    expect((await readFile(join(tempDir(), 'short.part'))).length).toBe(5)
    expect(existsSync(join(tempDir(), 'bad.part'))).toBe(false)
  })

  it('abort keeps a partial file and a later request resumes', async () => {
    const controller = new AbortController()
    const target = join(tempDir(), 'blob')
    serve((req, res) => {
      const offset = rangeOffset(req)
      if (offset)
        return send(res, payload.subarray(offset), 206, {
          'content-range': `bytes ${offset}-${payload.length - 1}/${payload.length}`,
        })
      res.writeHead(200)
      res.write(payload.subarray(0, 8))
      setTimeout(() => res.end(payload.subarray(8)), 50)
    })
    await expect(
      downloadFile(base, target, file, controller.signal, (n) => {
        if (n === 8) controller.abort()
      }),
    ).rejects.toThrow()
    expect((await readFile(`${target}.part`)).length).toBe(8)
    await downloadFile(base, target, file, signal(), noop)
    expect(await readFile(target)).toEqual(payload)
  })

  it('an already-aborted signal fails before any request', async () => {
    let count = 0
    serve((_, res) => { count++; send(res, payload) })
    const controller = new AbortController()
    controller.abort()
    await expect(downloadFile(base, join(tempDir(), 'blob'), file, controller.signal, noop)).rejects.toThrow()
    expect(count).toBe(0)
  })

  it('a failed writer does not poison the next writer for the same destination', async () => {
    let count = 0
    serve((_, res) => {
      count++
      if (count === 1) return send(res, 'fail', 500)
      send(res, payload)
    })
    const target = join(tempDir(), 'blob')
    const [first, second] = await Promise.allSettled([
      downloadFile(base, target, file, signal(), noop),
      downloadFile(base, target, file, signal(), noop),
    ])
    expect(first.status).toBe('rejected')
    expect(second.status).toBe('fulfilled')
    expect(await readFile(target)).toEqual(payload)
  })

  it('respects the concurrency limit across different destinations', async () => {
    let inFlight = 0
    let peak = 0
    serve((_, res) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      setTimeout(() => {
        inFlight--
        send(res, payload)
      }, 20)
    })
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) => downloadFile(base, join(tempDir(), `blob-${n}`), file, signal(), noop, { concurrency: 2 })),
    )
    expect(peak).toBeLessThanOrEqual(2)
    for (const n of [1, 2, 3, 4, 5]) expect(await readFile(join(tempDir(), `blob-${n}`))).toEqual(payload)
  })
})

describe('resolveFiles', () => {
  it('revision and paginated tree are resolved before selecting files', async () => {
    const paths: string[] = []
    serve((req, res) => {
      paths.push(req.url!)
      if (req.url!.includes('/revision/')) return send(res, JSON.stringify({ sha }))
      if (req.url === '/page2')
        return send(res, JSON.stringify([{ type: 'file', path: 'two.bin', size: 2, oid: '2'.repeat(40) }]))
      send(
        res,
        JSON.stringify([
          { type: 'file', path: 'one.bin', size: 1, oid: '1'.repeat(40) },
          { type: 'directory', path: 'nested', size: 0 },
        ]),
        200,
        { link: `<${base}/page2>; rel="next"` },
      )
    })
    const snapshot = await resolveFiles(base, 'team/model', 'release/v1')
    expect(snapshot.sha).toBe(sha)
    expect(snapshot.files.map((f) => f.path)).toEqual(['one.bin', 'two.bin'])
    expect(paths[0]!.endsWith('/revision/release%2Fv1')).toBe(true)
    expect(paths[1]).toBe(`/api/models/team/model/tree/${sha}?recursive=true&limit=1000`)
    expect(() => selectFiles(snapshot.files, ['missing/*'])).toThrow()
  })

  it('prefers the LFS oid over the git oid', async () => {
    const lfs = 'c'.repeat(64)
    serve((req, res) => {
      if (req.url!.includes('/revision/')) return send(res, JSON.stringify({ sha }))
      send(res, JSON.stringify([{ type: 'file', path: 'w.safetensors', size: 5, oid: 'a'.repeat(40), lfs: { oid: lfs } }]))
    })
    const snapshot = await resolveFiles(base, 'team/model', 'main')
    expect(snapshot.files).toEqual([{ path: 'w.safetensors', size: 5, oid: lfs }])
  })

  it('routes requests through a custom transport when given', async () => {
    const urls: string[] = []
    const transport = async (url: string): Promise<Response> => {
      urls.push(url)
      if (url.includes('/revision/')) return new Response(JSON.stringify({ sha }))
      return new Response(JSON.stringify([]))
    }
    const snapshot = await resolveFiles('https://hf.example', 'team/model', 'main', undefined, transport)
    expect(snapshot).toEqual({ sha, files: [] })
    expect(urls[0]).toBe('https://hf.example/api/models/team/model/revision/main')
  })

  function tree(items: unknown[], extra: (url: string) => Response | null = () => null) {
    return async (url: string): Promise<Response> => {
      if (url.includes('/revision/')) return new Response(JSON.stringify({ sha }))
      return extra(url) ?? new Response(JSON.stringify(items))
    }
  }

  it.each([
    ['an unsafe path', [{ type: 'file', path: '../escape', size: 1 }], /不合法/],
    ['a negative size', [{ type: 'file', path: 'a.bin', size: -1 }], /文件大小无效/],
    ['a fractional size', [{ type: 'file', path: 'a.bin', size: 1.5 }], /文件大小无效/],
    ['a malformed oid', [{ type: 'file', path: 'a.bin', size: 1, oid: 'xyz' }], /hash 无效/],
  ])('rejects a tree with %s', async (_label, items, message) => {
    await expect(resolveFiles('https://hf.example', 'team/model', 'main', undefined, tree(items))).rejects.toThrow(message)
  })

  it('rejects a revision that does not resolve to a commit sha', async () => {
    const transport = async (): Promise<Response> => new Response(JSON.stringify({ sha: 'main' }))
    await expect(resolveFiles('https://hf.example', 'a/b', 'main', undefined, transport)).rejects.toThrow(/有效提交/)
  })

  it('rejects HTTP errors from the manifest API', async () => {
    const transport = async (): Promise<Response> => new Response('', { status: 404 })
    await expect(resolveFiles('https://hf.example', 'a/b', 'main', undefined, transport)).rejects.toThrow('模型清单 HTTP 404')
  })

  it('rejects pagination that leaves the endpoint origin', async () => {
    const transport = tree([], (url) =>
      url.includes('/tree/') ? new Response('[]', { headers: { link: '<https://evil.example/next>; rel="next"' } }) : null,
    )
    await expect(resolveFiles('https://hf.example', 'a/b', 'main', undefined, transport)).rejects.toThrow(/分页无效/)
  })

  it('rejects a pagination loop', async () => {
    const transport = tree([], (url) =>
      url.includes('/tree/') ? new Response('[]', { headers: { link: `<${url}>; rel="next"` } }) : null,
    )
    await expect(resolveFiles('https://hf.example', 'a/b', 'main', undefined, transport)).rejects.toThrow(/分页无效/)
  })
})

describe('path and pattern helpers', () => {
  it('unsafe paths are rejected', () => {
    for (const path of ['../escape', '/outside', 'C:\\bad', 'a\\b', 'a:stream', '', '.', 'a/../../b'])
      expect(() => safePath('/cache', path), path).toThrow()
  })

  it('safe nested paths resolve under the root', () => {
    expect(safePath('/cache', 'a/b/c.bin')).toBe(join('/cache', 'a/b/c.bin'))
    expect(safePath('/cache', 'a/../b')).toBe(join('/cache', 'b'))
  })

  it('matchesFile treats * as any run of characters and escapes regex metacharacters', () => {
    expect(matchesFile('transformer/*', 'transformer/model.safetensors')).toBe(true)
    expect(matchesFile('transformer/*', 'transformer/nested/x.bin')).toBe(true)
    expect(matchesFile('transformer/*', 'vae/x.bin')).toBe(false)
    expect(matchesFile('model.safetensors', 'modelXsafetensors')).toBe(false)
    expect(matchesFile('a+b(1).json', 'a+b(1).json')).toBe(true)
    expect(matchesFile('*.json', 'nested/config.json')).toBe(true)
    expect(matchesFile('config.json', 'nested/config.json')).toBe(false)
  })

  it('selectFiles keeps everything without patterns and filters with them', () => {
    const files: ModelFile[] = [
      { path: 'a/1.bin', size: 1, oid: null },
      { path: 'b/2.bin', size: 1, oid: null },
      { path: 'c.json', size: 1, oid: null },
    ]
    expect(selectFiles(files)).toBe(files)
    expect(selectFiles(files, [])).toBe(files)
    expect(selectFiles(files, ['a/*', 'c.json']).map((f) => f.path)).toEqual(['a/1.bin', 'c.json'])
    expect(() => selectFiles(files, ['a/*', 'd/*'])).toThrow('仓库缺少文件：d/*')
  })
})

describe('file helpers', () => {
  it('hashFile streams a SHA256 and fileSize reports -1 for missing files', async () => {
    const path = join(tempDir(), 'x')
    await writeFile(path, payload)
    expect(await hashFile(path)).toBe(file.oid)
    expect(await fileSize(path)).toBe(payload.length)
    expect(await fileSize(join(tempDir(), 'missing'))).toBe(-1)
    await expect(hashFile(join(tempDir(), 'missing'))).rejects.toThrow()
  })

  it('materialized weights remain readable without symbolic links', async () => {
    await writeFile(join(tempDir(), 'source'), payload)
    await materialize(join(tempDir(), 'source'), join(tempDir(), 'nested/target'))
    expect(await readFile(join(tempDir(), 'nested/target'))).toEqual(payload)
    const [a, b] = await Promise.all([stat(join(tempDir(), 'source')), stat(join(tempDir(), 'nested/target'))])
    expect(b.ino).toBe(a.ino)
  })

  it('materialize leaves an existing target alone', async () => {
    await writeFile(join(tempDir(), 'source'), payload)
    await writeFile(join(tempDir(), 'target'), 'existing')
    await materialize(join(tempDir(), 'source'), join(tempDir(), 'target'))
    expect(await readFile(join(tempDir(), 'target'), 'utf8')).toBe('existing')
  })
})

describe('validateSnapshot', () => {
  async function put(rel: string, content = 'x'): Promise<ModelFile> {
    const path = join(tempDir(), rel)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
    return { path: rel, size: Buffer.byteLength(content), oid: null }
  }

  it('component completeness requires its own weights and every index shard', async () => {
    const root = tempDir()
    const files = [await put('transformer/config.json', '{}'), await put('vae/model.safetensors', 'vae')]
    expect(await validateSnapshot(root, files, 'dit', 'transformer')).toBe(false)
    files.push(await put('transformer/model.safetensors', 'dit'))
    expect(await validateSnapshot(root, files, 'dit', 'transformer')).toBe(true)
    const index = JSON.stringify({ weight_map: { a: 'missing.safetensors' } })
    files.push(await put('transformer/model.safetensors.index.json', index))
    expect(await validateSnapshot(root, files, 'dit', 'transformer')).toBe(false)
    await put('transformer/missing.safetensors', 'shard')
    expect(await validateSnapshot(root, files, 'dit', 'transformer')).toBe(true)
  })

  it('an index with an empty weight map is incomplete', async () => {
    const files = [
      await put('vae/config.json', '{}'),
      await put('vae/model.safetensors', 'w'),
      await put('vae/model.safetensors.index.json', JSON.stringify({ weight_map: {} })),
    ]
    expect(await validateSnapshot(tempDir(), files, 'vae', 'vae')).toBe(false)
  })

  it('an empty file list or a size mismatch is never complete', async () => {
    expect(await validateSnapshot(tempDir(), [], 'comfyui')).toBe(false)
    const entry = await put('w.safetensors', 'abc')
    expect(await validateSnapshot(tempDir(), [entry], 'comfyui')).toBe(true)
    expect(await validateSnapshot(tempDir(), [{ ...entry, size: 4 }], 'comfyui')).toBe(false)
  })

  it('support requires the pipeline entry points', async () => {
    const files = [await put('model_index.json', '{}'), await put('pipeline_moss_image.py', 'x')]
    expect(await validateSnapshot(tempDir(), files, 'support')).toBe(false)
    files.push(await put('scheduler/scheduler_config.json', '{}'))
    expect(await validateSnapshot(tempDir(), files, 'support')).toBe(true)
  })

  it('a text encoder needs a tokenizer config plus tokenizer.json or vocab+merges', async () => {
    const files = [await put('text_encoder/config.json', '{}'), await put('text_encoder/model.safetensors', 'w')]
    expect(await validateSnapshot(tempDir(), files, 'text_encoder', 'text_encoder')).toBe(false)
    await put('tokenizer/tokenizer_config.json', '{}')
    expect(await validateSnapshot(tempDir(), files, 'text_encoder', 'text_encoder')).toBe(false)
    await put('tokenizer/vocab.json', '{}')
    expect(await validateSnapshot(tempDir(), files, 'text_encoder', 'text_encoder')).toBe(false)
    await put('tokenizer/merges.txt', 'm')
    expect(await validateSnapshot(tempDir(), files, 'text_encoder', 'text_encoder')).toBe(true)
  })

  it('an unsafe entry path makes the snapshot invalid instead of throwing', async () => {
    expect(await validateSnapshot(tempDir(), [{ path: '../x', size: 1, oid: null }], 'comfyui')).toBe(false)
  })
})
