import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'

interface ParentPort {
  on(event: 'message', listener: (event: { data?: unknown }) => void): void
  postMessage(message: unknown): void
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort
const token = process.env['CLOVER_BACKEND_TOKEN'] ?? ''
const host = process.env['CLOVER_BACKEND_HOST'] ?? '127.0.0.1'
const webRoot = process.env['CLOVER_WEB_ROOT'] ?? ''
const requestedPort = Number(process.env['CLOVER_BACKEND_PORT'] ?? 0) || 0
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()

/** An RPC failure from main, with its E_* code when main gave one. */
class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

/** Largest picture or mask upload (bytes). */
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024
let nextId = 0

function rpc<T>(method: string, params?: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!parentPort) {
      reject(new Error('backend is not running inside Electron'))
      return
    }
    const id = `rpc-${++nextId}`
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`backend rpc timeout: ${method}`))
    }, 120_000)
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
    parentPort.postMessage({ type: 'rpc', id, method, params })
  })
}

function authorized(req: IncomingMessage): boolean {
  if (!token) return false
  if (req.headers.authorization === `Bearer ${token}`) return true
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  return url.searchParams.get('token') === token
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  })
  res.end(data)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let body = ''
  for await (const chunk of req) {
    body += String(chunk)
    if (body.length > 2_000_000) throw new Error('request too large')
  }
  return body ? JSON.parse(body) : undefined
}

async function readBytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.byteLength
    if (size > MAX_UPLOAD_BYTES) throw new RpcError('图片文件太大了（不超过 80 MB）', 'E_IMAGE_TOO_LARGE')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  if (!webRoot) return false
  const requested = pathname === '/' ? '/web.html' : pathname
  if (!/^\/(web\.html|assets\/|favicon)/.test(requested)) return false
  const root = resolve(webRoot)
  const target = resolve(join(root, normalize(requested).replace(/^\.(?:\.|$)/, '')))
  if (target !== root && !target.startsWith(root + sep)) return false
  try {
    const data = await readFile(target)
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': data.byteLength,
      'cache-control': requested === '/web.html' ? 'no-cache' : 'public, max-age=3600',
    })
    res.end(data)
    return true
  } catch {
    return false
  }
}

function sendBinary(res: ServerResponse, mime: string, base64: string): void {
  const data = Buffer.from(base64, 'base64')
  res.writeHead(200, {
    'content-type': mime,
    'content-length': data.byteLength,
    'cache-control': 'private, max-age=60',
  })
  res.end(data)
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method === 'OPTIONS') {
      send(res, 204, {})
      return
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && (await serveStatic(new URL(req.url ?? '/', 'http://127.0.0.1').pathname, res))) {
      return
    }
    if (req.url === '/health') {
      send(res, 200, { ok: true, service: 'clover-backend', version: 1 })
      return
    }
    if (!authorized(req)) {
      send(res, 401, { error: 'unauthorized' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      send(res, 200, await rpc('listJobs'))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/studio/bootstrap') {
      const [projects, models, gallery] = await Promise.all([rpc('listProjects'), rpc('listModels'), rpc('listGallery', { limit: 12 })])
      send(res, 200, { projects, instances: [], models, gallery })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      send(res, 200, await rpc('listProjects'))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/projects') {
      send(res, 200, await rpc('saveProject', await readBody(req)))
      return
    }
    if (url.pathname.startsWith('/api/projects/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/projects/'.length))
      if (req.method === 'GET') {
        send(res, 200, await rpc('getProject', { id }))
        return
      }
      if (req.method === 'DELETE') {
        send(res, 200, await rpc('deleteProject', { id }))
        return
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/models') {
      send(res, 200, await rpc('listModels'))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/gallery') {
      send(
        res,
        200,
        await rpc('listGallery', {
          cursor: url.searchParams.get('cursor') ?? undefined,
          limit: Number(url.searchParams.get('limit') ?? 48) || 48,
          query: url.searchParams.get('query') ?? undefined,
          root: url.searchParams.get('root') ?? undefined,
        }),
      )
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
      send(res, 200, await rpc('getJob', { id: decodeURIComponent(url.pathname.slice('/api/jobs/'.length)) }))
      return
    }
    // Pictures for a Studio project, sent as the raw request body (image/png, image/jpeg, image/webp).
    if (req.method === 'POST' && url.pathname === '/api/studio/import-image') {
      const projectId = url.searchParams.get('projectId') ?? ''
      send(res, 200, await rpc('importImage', { projectId, base64: (await readBytes(req)).toString('base64') }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/studio/save-mask') {
      const projectId = url.searchParams.get('projectId') ?? ''
      const canvasId = url.searchParams.get('canvasId') ?? ''
      send(res, 200, await rpc('saveMask', { projectId, canvasId, base64: (await readBytes(req)).toString('base64') }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/engine-jobs') {
      send(res, 200, await rpc('startEngineJob', await readBody(req)))
      return
    }
    if (req.method === 'POST' && url.pathname.endsWith('/cancel') && url.pathname.startsWith('/api/jobs/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/jobs/'.length, -'/cancel'.length))
      send(res, 200, await rpc('cancelJob', { id }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/gallery/file') {
      const file = url.searchParams.get('path') ?? ''
      const data = await rpc<{ base64: string; mime: string }>('galleryFile', { path: file })
      sendBinary(res, data.mime, data.base64)
      return
    }
    send(res, 404, { error: 'not found' })
  } catch (error) {
    const code = error instanceof RpcError ? error.code : undefined
    // A request main refused for what it asked (E_INPUT*, E_IMAGE*, E_NOT_SUPPORTED) is the client's to fix.
    const status = code && /^E_(INPUT|IMAGE|NOT_SUPPORTED)/.test(code) ? 400 : 500
    send(res, status, { error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) })
  }
}

// handleRequest answers every failure itself (its catch sends the error response).
const server = createServer((req, res) => void handleRequest(req, res))

const wss = new WebSocketServer({ noServer: true })
const clients = new Set<WebSocket>()

wss.on('connection', (socket) => {
  clients.add(socket)
  socket.send(JSON.stringify({ type: 'hello', service: 'clover-backend', version: 1 }))
  socket.on('close', () => clients.delete(socket))
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname !== '/ws' || !authorized(req)) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

function broadcast(message: unknown): void {
  const data = JSON.stringify(message)
  for (const client of clients) if (client.readyState === 1) client.send(data)
}

parentPort?.on('message', (event) => {
  const message = event.data as Record<string, unknown> | undefined
  if (!message) return
  if (message['type'] === 'rpc-result') {
    const entry = pending.get(String(message['id']))
    if (!entry) return
    pending.delete(String(message['id']))
    clearTimeout(entry.timer)
    if (message['error'])
      entry.reject(new RpcError(String(message['error']), typeof message['code'] === 'string' ? message['code'] : undefined))
    else entry.resolve(message['result'])
    return
  }
  if (message['type'] === 'event') {
    broadcast({ type: 'event', channel: message['channel'], payload: message['payload'] })
  }
})

server.listen(requestedPort, host, () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  parentPort?.postMessage({ type: 'ready', port })
  console.log(`[clover-backend] listening on ${host}:${port}`)
})

process.on('disconnect', () => process.exit(0))
