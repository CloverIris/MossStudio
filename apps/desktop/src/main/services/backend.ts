import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import type { BackendInfo, WebAccessInfo } from '@shared/backend'
import type { JobRecord } from '@shared/types'
import { onEmit } from '../lib/events'
import { cancelJob, getJob, listJobs, startEngineJob } from './supervisor'
import { resolveCanvasAdapters } from './adapterResolution'
import { getCatalog } from './models'
import { listGallery, readGalleryFile } from './gallery'
import { deleteProject, getProject, listProjects, saveProject } from './projects'
import { getSettings } from './settings'

let child: UtilityProcess | null = null
let info: BackendInfo = { ready: false, url: null, token: null }
let unsubscribe: (() => void) | null = null

function handleRpc(message: Record<string, unknown>): void {
  const id = String(message['id'] ?? '')
  const method = String(message['method'] ?? '')
  const params = (message['params'] ?? {}) as Record<string, unknown>
  const respond = (result: unknown, error?: string): void => {
    try {
      child?.postMessage(error ? { type: 'rpc-result', id, error } : { type: 'rpc-result', id, result })
    } catch {
      // child gone
    }
  }
  void (async () => {
    try {
      if (method === 'startEngineJob') {
        // The renderer posts model-library adapter ids; resolve them here as well,
        // because this RPC path does not go through the IPC `startJob` wrapper.
        const hostId = typeof params['hostId'] === 'string' && params['hostId'] ? params['hostId'] : undefined
        const adapters = await resolveCanvasAdapters(getSettings(), params['adapters'], { hostId })
        respond(await startEngineJob({ ...params, adapters } as never))
      } else if (method === 'cancelJob') {
        respond(await cancelJob(String(params['id'] ?? '')))
      } else if (method === 'getJob') {
        respond(await getJob(String(params['id'] ?? '')))
      } else if (method === 'listJobs') {
        respond(await listJobs())
      } else if (method === 'listProjects') {
        respond(listProjects())
      } else if (method === 'getProject') {
        respond(getProject(String(params['id'] ?? '')))
      } else if (method === 'saveProject') {
        respond(saveProject(params as never))
      } else if (method === 'deleteProject') {
        deleteProject(String(params['id'] ?? ''))
        respond(true)
      } else if (method === 'listModels') {
        respond(await getCatalog(getSettings()))
      } else if (method === 'listGallery') {
        respond(await listGallery(getSettings(), params as never))
      } else if (method === 'galleryFile') {
        respond(await readGalleryFile(String(params['path'] ?? '')))
      } else {
        respond(null, `unknown backend method: ${method}`)
      }
    } catch (error) {
      respond(null, error instanceof Error ? error.message : String(error))
    }
  })()
}

export async function startBackend(): Promise<BackendInfo> {
  const token = randomBytes(24).toString('hex')
  const ready = new Promise<BackendInfo>((resolve) => {
    const timer = setTimeout(() => resolve({ ready: false, url: null, token: null, error: 'backend startup timeout' }), 8000)
    try {
      child = utilityProcess.fork(join(__dirname, 'backend.js'), [], {
        env: {
          ...process.env,
          CLOVER_BACKEND_TOKEN: token,
          CLOVER_BACKEND_HOST: getSettings().lanWebEnabled ? '0.0.0.0' : '127.0.0.1',
          CLOVER_WEB_ROOT: join(app.getAppPath(), 'out', 'renderer'),
          CLOVER_BACKEND_PORT: String(getSettings().lanWebPort ?? 0),
        },
        stdio: 'pipe',
      })
    } catch (error) {
      clearTimeout(timer)
      resolve({ ready: false, url: null, token: null, error: error instanceof Error ? error.message : String(error) })
      return
    }
    child.on('message', (message: unknown) => {
      const payload = message as Record<string, unknown>
      if (payload?.['type'] === 'ready') {
        clearTimeout(timer)
        const port = Number(payload['port'] ?? 0)
        resolve({ ready: true, url: `http://127.0.0.1:${port}`, token })
        return
      }
      if (payload?.['type'] === 'rpc') handleRpc(payload)
    })
    child.on('exit', (code) => {
      info = { ready: false, url: null, token: null, error: `backend exited (${code})` }
      if (!info.ready) {
        clearTimeout(timer)
        resolve(info)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (line) console.error(`[backend] ${line}`)
    })
  })
  info = await ready
  if (info.ready) {
    unsubscribe = onEmit((channel, payload) => {
      try {
        child?.postMessage({ type: 'event', channel, payload })
      } catch {
        // child gone
      }
    })
    console.log(`[backend] ${info.url}`)
  } else if (info.error) {
    console.error(`[backend] ${info.error}`)
  }
  return info
}

export function getBackendInfo(): BackendInfo {
  return info
}

export function stopBackend(): void {
  unsubscribe?.()
  unsubscribe = null
  try {
    child?.kill()
  } catch {
    // ignore
  }
  child = null
  info = { ready: false, url: null, token: null }
}

export function getWebAccessInfo(): WebAccessInfo {
  if (!info.ready || !info.url || !info.token) {
    return { ready: false, urls: [], token: null, port: null, instanceId: null, error: info.error ?? '后端尚未就绪' }
  }
  const port = Number(new URL(info.url).port)
  const token = encodeURIComponent(info.token)
  const instanceId = getSettings().lanWebInstanceId
  const suffix = instanceId ? `&instance=${encodeURIComponent(instanceId)}` : ''
  const hosts: Array<{ host: string; score: number }> = [{ host: '127.0.0.1', score: 100 }]
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      if (address.address.startsWith('169.254.')) continue
      const virtual = /^(bridge|utun|docker|vbox|vmnet|veth|virbr|vEthernet|VirtualBox|VMware|Tailscale|ZeroTier)/i.test(name)
      const wired = /^(en0|en1|eth0|wlan|wi-?fi|ethernet)/i.test(name)
      hosts.push({ host: address.address, score: virtual ? 50 : wired ? 10 : 20 })
    }
  }
  const unique = [...new Map(hosts.map((item) => [item.host, item])).values()]
    .sort((a, b) => a.score - b.score)
    .map((item) => item.host)
  return {
    ready: true,
    token: info.token,
    port,
    instanceId,
    urls: unique.map((host) => `http://${host}:${port}/?token=${token}${suffix}`),
  }
}
