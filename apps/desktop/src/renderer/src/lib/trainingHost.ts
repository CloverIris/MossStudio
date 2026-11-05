/**
 * Where training runs: 'local' or the id of an SSH host. Shared by the Training
 * page and the trainer window (a separate OS window), so it lives in localStorage
 * and other windows hear about changes through the `storage` event.
 */
const KEY = 'mossstudio:training-host'

export const TRAINING_HOST_EVENT = 'mossstudio:training-host-changed'

export function getSelectedTrainingHost(): string {
  try { return localStorage.getItem(KEY) || 'local' } catch { return 'local' }
}

export function setSelectedTrainingHost(id: string): void {
  try { localStorage.setItem(KEY, id || 'local') } catch { /* storage unavailable */ }
}

export function announceTrainingHost(id: string): void {
  setSelectedTrainingHost(id)
  window.dispatchEvent(new CustomEvent(TRAINING_HOST_EVENT, { detail: id }))
}

/**
 * The location actually in use. Remote hosts only count while the remote-hosts
 * feature is on and the host still exists; otherwise training runs locally.
 */
export function resolveTrainingHost(
  id: string | null | undefined,
  hosts: ReadonlyArray<{ id: string; kind: string }>,
  remoteHostsEnabled: boolean,
): string {
  if (!id || id === 'local' || !remoteHostsEnabled) return 'local'
  return hosts.some((host) => host.id === id && host.kind === 'ssh') ? id : 'local'
}
