import type { BackendInfo } from '@shared/backend'
import { Ipc } from '@shared/channels'
import type { ProjectCanvas, ProjectDocument, ProjectSummary } from '@shared/types'
import { call } from './api'

export interface StudioProjectInput {
  id?: string
  name: string
  canvases: ProjectCanvas[]
  selectedCanvasId?: string
  seriesId?: string
  page?: number
}

/**
 * The Studio's data boundary. Electron uses IPC today; the LAN WebUI will
 * provide an HTTP/WS implementation of this same interface.
 */
export interface StudioClient {
  listProjects(): Promise<ProjectSummary[]>
  getProject(id: string): Promise<ProjectDocument | null>
  saveProject(input: StudioProjectInput): Promise<ProjectDocument>
  backendInfo(): Promise<BackendInfo>
}

export const electronStudioClient: StudioClient = {
  listProjects: () => call<ProjectSummary[]>(Ipc.projectsList),
  getProject: (id) => call<ProjectDocument | null>(Ipc.projectGet, { id }),
  saveProject: (input) => call<ProjectDocument>(Ipc.projectSave, input),
  backendInfo: () => call<BackendInfo>(Ipc.backendInfo),
}

/**
 * HTTP implementation for the LAN WebUI. The web shell will construct this
 * with the token from its URL/QR code; the desktop shell keeps using IPC.
 */
export class WebStudioClient implements StudioClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? `HTTP ${response.status}`)
    }
    return (await response.json()) as T
  }

  listProjects(): Promise<ProjectSummary[]> {
    return this.request<ProjectSummary[]>('/api/projects')
  }

  getProject(id: string): Promise<ProjectDocument | null> {
    return this.request<ProjectDocument | null>(`/api/projects/${encodeURIComponent(id)}`)
  }

  saveProject(input: StudioProjectInput): Promise<ProjectDocument> {
    return this.request<ProjectDocument>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async backendInfo(): Promise<BackendInfo> {
    return { ready: true, url: this.baseUrl, token: this.token }
  }
}
