import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type { AdapterEntry, DownloadTask, ManagedHost, ModelBundle, ModelEntry } from '@shared/types'
import { call, onEvent } from '../../lib/api'
import { useApp } from '../../store'
import { bundleComponentIds } from './logic'

export interface RemoteInventory {
  root: string
  files: number
  models: Array<{ id: string; installed: boolean; path?: string }>
  adapters: Array<{ id: string; installed: boolean; path?: string }>
}

/**
 * One machine whose models the page shows: this computer, or an SSH host
 * (only when 远程主机 is turned on). Every action goes through here so the
 * page renders the same way for both.
 */
export interface ModelLocation {
  kind: 'local' | 'remote'
  host: ManagedHost | null
  /** False for a remote host until its inventory has been read; actions are hidden until then. */
  ready: boolean
  tasks: DownloadTask[]
  /** Remote only: the last inventory scan, null while scanning or when it failed. */
  inventory: RemoteInventory | null
  scanning: boolean
  scanError: string | null
  isModelInstalled: (model: ModelEntry) => boolean
  isAdapterInstalled: (adapter: AdapterEntry) => boolean
  download: (kind: 'model' | 'adapter', id: string) => Promise<void>
  downloadBundle: (bundle: ModelBundle) => Promise<void>
  pause: (task: DownloadTask) => Promise<void>
  resume: (task: DownloadTask) => Promise<void>
  cancel: (task: DownloadTask) => Promise<void>
  remove: (kind: 'model' | 'adapter', id: string) => Promise<void>
  /** Removes several entries at once; on a remote host files they share with what stays are kept. */
  removeMany: (kind: 'model' | 'adapter', ids: string[]) => Promise<void>
  rescan: () => void
}

export function useSshHosts(enabled: boolean): ManagedHost[] {
  const [hosts, setHosts] = useState<ManagedHost[]>([])
  useEffect(() => {
    if (!enabled) {
      setHosts([])
      return
    }
    const load = (): void => {
      call<ManagedHost[]>(Ipc.hostsList)
        .then((list) => setHosts(list.filter((host) => host.kind === 'ssh')))
        .catch(() => undefined)
    }
    load()
    return onEvent(Events.hostsChanged, load)
  }, [enabled])
  return hosts
}

export function useModelLocation(host: ManagedHost | null): ModelLocation {
  const catalog = useApp((state) => state.catalog)
  const downloads = useApp((state) => state.downloads)
  const downloadModel = useApp((state) => state.downloadModel)
  const downloadAdapter = useApp((state) => state.downloadAdapter)
  const downloadBundleLocal = useApp((state) => state.downloadBundle)
  const pauseDownload = useApp((state) => state.pauseDownload)
  const cancelDownload = useApp((state) => state.cancelDownload)
  const deleteModel = useApp((state) => state.deleteModel)
  const [inventory, setInventory] = useState<RemoteInventory | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const sequence = useRef(0)
  const hostId = host?.id ?? null

  const tasks = useMemo(
    () => downloads.filter((task) => (hostId ? task.hostId === hostId : !task.hostId) && task.state !== 'canceled'),
    [downloads, hostId],
  )

  const rescan = useCallback(() => {
    const run = ++sequence.current
    if (!hostId) {
      setInventory(null)
      setScanning(false)
      setScanError(null)
      return
    }
    setScanning(true)
    setScanError(null)
    call<RemoteInventory>(Ipc.modelsRemoteInventory, { hostId })
      .then((result) => {
        if (run === sequence.current) setInventory(result)
      })
      .catch((cause: unknown) => {
        if (run === sequence.current) {
          setInventory(null)
          setScanError(cause instanceof Error ? cause.message : String(cause))
        }
      })
      .finally(() => {
        if (run === sequence.current) setScanning(false)
      })
  }, [hostId])

  useEffect(() => {
    setInventory(null)
    rescan()
    if (hostId) void call(Ipc.remoteDownloadsRefresh, { hostId }).catch(() => undefined)
  }, [hostId, host?.modelsRoot, rescan])

  // A finished remote download changes what the host has.
  const doneKey = tasks.filter((task) => task.state === 'done').map((task) => task.id).join(',')
  useEffect(() => {
    if (hostId && doneKey) rescan()
  }, [doneKey, hostId, rescan])

  const remoteInstalled = useMemo(() => {
    const models = new Map(inventory?.models.map((entry) => [entry.id, entry]) ?? [])
    const adapters = new Map(inventory?.adapters.map((entry) => [entry.id, entry]) ?? [])
    return { models, adapters }
  }, [inventory])

  const isModelInstalled = useCallback(
    (model: ModelEntry) => (hostId ? Boolean(remoteInstalled.models.get(model.id)?.installed) : model.installed),
    [hostId, remoteInstalled],
  )
  const isAdapterInstalled = useCallback(
    (adapter: AdapterEntry) => (hostId ? Boolean(remoteInstalled.adapters.get(adapter.id)?.installed) : adapter.installed),
    [hostId, remoteInstalled],
  )

  const download = useCallback(
    async (kind: 'model' | 'adapter', id: string) => {
      if (hostId) {
        await call(Ipc.modelsRemoteDownload, { hostId, modelId: id })
        return
      }
      if (kind === 'model') await downloadModel(id)
      else await downloadAdapter(id)
    },
    [downloadAdapter, downloadModel, hostId],
  )

  const downloadBundle = useCallback(
    async (bundle: ModelBundle) => {
      if (!hostId) {
        await downloadBundleLocal(bundle.id)
        return
      }
      for (const id of bundleComponentIds(bundle)) {
        const model = catalog?.models.find((entry) => entry.id === id)
        if (model && !remoteInstalled.models.get(id)?.installed) await call(Ipc.modelsRemoteDownload, { hostId, modelId: id })
      }
    },
    [catalog, downloadBundleLocal, hostId, remoteInstalled],
  )

  const pause = useCallback(
    async (task: DownloadTask) => {
      if (task.hostId) await call(Ipc.remoteDownloadControl, { hostId: task.hostId, taskId: task.id, operation: 'pause' })
      else await pauseDownload(task.id)
    },
    [pauseDownload],
  )

  const resume = useCallback(
    async (task: DownloadTask) => {
      if (task.hostId) await call(Ipc.remoteDownloadControl, { hostId: task.hostId, taskId: task.id, operation: 'resume' })
      else if (task.kind === 'model') await downloadModel(task.targetId)
      else await downloadAdapter(task.targetId)
    },
    [downloadAdapter, downloadModel],
  )

  const cancel = useCallback(
    async (task: DownloadTask) => {
      if (task.hostId) await call(Ipc.remoteDownloadControl, { hostId: task.hostId, taskId: task.id, operation: 'cancel' })
      else await cancelDownload(task.id)
    },
    [cancelDownload],
  )

  const removeMany = useCallback(
    async (kind: 'model' | 'adapter', ids: string[]) => {
      if (!ids.length) return
      if (!hostId) {
        for (const id of ids) await deleteModel(kind, id)
        return
      }
      // The host decides per file: parts of one download folder are shared
      // (e.g. the SFT main model, text encoder and VAE), so never delete the folder.
      try {
        await call(Ipc.modelsRemoteDelete, { hostId, ids })
      } finally {
        rescan()
      }
    },
    [deleteModel, hostId, rescan],
  )

  const remove = useCallback(
    (kind: 'model' | 'adapter', id: string) => removeMany(kind, [id]),
    [removeMany],
  )

  return {
    kind: hostId ? 'remote' : 'local',
    host,
    ready: !hostId || inventory !== null,
    tasks,
    inventory,
    scanning,
    scanError,
    isModelInstalled,
    isAdapterInstalled,
    download,
    downloadBundle,
    pause,
    resume,
    cancel,
    remove,
    removeMany,
    rescan,
  }
}
