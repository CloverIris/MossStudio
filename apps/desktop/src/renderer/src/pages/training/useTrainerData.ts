import { useCallback, useEffect, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type { TrainerVersion, TrainingHost } from '@shared/types'
import { call, onEvent } from '../../lib/api'
import {
  TRAINING_HOST_EVENT,
  announceTrainingHost,
  getSelectedTrainingHost,
  resolveTrainingHost,
} from '../../lib/trainingHost'
import { useApp } from '../../store'

export interface TrainerData {
  hosts: TrainingHost[]
  sshHosts: TrainingHost[]
  versions: TrainerVersion[]
  loading: boolean
  /** The location in use (always 'local' while the remote-hosts feature is off). */
  hostId: string
  setHostId: (id: string) => void
  refresh: () => Promise<void>
}

/** Hosts, trainer versions and the selected location, kept in sync across windows. */
export function useTrainerData(): TrainerData {
  const remoteHostsEnabled = useApp((state) => state.settings?.remoteHostsEnabled ?? false)
  const [hosts, setHosts] = useState<TrainingHost[]>([])
  const [versions, setVersions] = useState<TrainerVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(getSelectedTrainingHost)

  const refresh = useCallback(async () => {
    try {
      const [hostList, versionList] = await Promise.all([
        call<TrainingHost[]>(Ipc.trainerHosts),
        call<TrainerVersion[]>(Ipc.trainerAllVersions),
      ])
      setHosts(hostList)
      setVersions(versionList)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh().catch(() => undefined) }, [refresh])
  useEffect(() => onEvent(Events.hostsChanged, () => { void refresh().catch(() => undefined) }), [refresh])
  useEffect(() => {
    const sync = (): void => setSelected(getSelectedTrainingHost())
    window.addEventListener(TRAINING_HOST_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(TRAINING_HOST_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const setHostId = useCallback((id: string) => {
    announceTrainingHost(id)
    setSelected(id)
  }, [])

  return {
    hosts,
    sshHosts: hosts.filter((host) => host.kind === 'ssh'),
    versions,
    loading,
    hostId: resolveTrainingHost(selected, hosts, remoteHostsEnabled),
    setHostId,
    refresh,
  }
}
