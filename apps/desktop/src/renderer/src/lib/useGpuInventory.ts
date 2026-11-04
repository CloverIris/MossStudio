import { useCallback, useEffect, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type { GpuInventorySnapshot } from '@shared/types'
import { call, onEvent } from './api'

/** The NVIDIA GPUs the main process found, kept current by its inventory events. */
export function useGpuInventory(): {
  inventory: GpuInventorySnapshot | null
  refreshing: boolean
  refresh: () => Promise<GpuInventorySnapshot | null>
} {
  const [inventory, setInventory] = useState<GpuInventorySnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let canceled = false
    void call<GpuInventorySnapshot>(Ipc.gpuInventory)
      .then((snapshot) => { if (!canceled) setInventory(snapshot) })
      .catch((error: unknown) => {
        if (!canceled) setInventory({ scannedAt: new Date().toISOString(), status: 'error', devices: [], error: error instanceof Error ? error.message : String(error) })
      })
    const off = onEvent<GpuInventorySnapshot>(Events.gpuInventory, setInventory)
    return () => { canceled = true; off() }
  }, [])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const snapshot = await call<GpuInventorySnapshot>(Ipc.gpuInventoryRefresh)
      setInventory(snapshot)
      return snapshot
    } catch (error) {
      const failed: GpuInventorySnapshot = { scannedAt: new Date().toISOString(), status: 'error', devices: [], error: error instanceof Error ? error.message : String(error) }
      setInventory(failed)
      return failed
    } finally {
      setRefreshing(false)
    }
  }, [])

  return { inventory, refreshing, refresh }
}
