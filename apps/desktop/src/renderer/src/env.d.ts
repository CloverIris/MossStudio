/// <reference types="vite/client" />

declare global {
  interface Window {
    clover: {
      invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>
      on(channel: string, callback: (data: unknown) => void): () => void
      platform: string
      version: string
      acrylic: boolean
      windowKind: 'launcher' | 'creator' | 'terminal' | 'trainer' | 'devices'
      channel: string
      /** Disk path of a dropped or pasted File (Electron's webUtils); '' when it has none. */
      pathForFile?: (file: File) => string
    }
  }
}

export {}
