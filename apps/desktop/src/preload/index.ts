import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    return ipcRenderer.invoke(channel, payload)
  },
  on(channel: string, callback: (data: unknown) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  /** Disk path of a dropped File (studio:import-image takes it); '' for a paste or a browser file. */
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  platform: process.platform,
  version: process.versions.electron,
  acrylic: process.argv.includes('--clover-acrylic'),
  windowKind: (process.argv.find((arg) => arg.startsWith('--clover-window='))?.split('=')[1] ?? 'studio') as 'studio' | 'trainer',
  channel: process.argv.find((arg) => arg.startsWith('--clover-channel='))?.split('=')[1] ?? 'dev',
}

contextBridge.exposeInMainWorld('clover', api)
