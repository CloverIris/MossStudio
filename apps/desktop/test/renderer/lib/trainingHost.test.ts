import { describe, expect, it, vi } from 'vitest'
import {
  TRAINING_HOST_EVENT,
  announceTrainingHost,
  getSelectedTrainingHost,
  resolveTrainingHost,
  setSelectedTrainingHost,
} from '@renderer/lib/trainingHost'

describe('lib/trainingHost', () => {
  it('defaults to local and round-trips the selection through localStorage', () => {
    expect(getSelectedTrainingHost()).toBe('local')
    setSelectedTrainingHost('ssh-gpu')
    expect(getSelectedTrainingHost()).toBe('ssh-gpu')
    expect(localStorage.getItem('mossstudio:training-host')).toBe('ssh-gpu')
  })

  it('stores an empty id as local', () => {
    setSelectedTrainingHost('')
    expect(getSelectedTrainingHost()).toBe('local')
  })

  it('falls back to local when storage throws', () => {
    const denied = (): never => { throw new Error('denied') }
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied })
    expect(() => setSelectedTrainingHost('ssh')).not.toThrow()
    expect(getSelectedTrainingHost()).toBe('local')
  })

  it('announce stores the host and dispatches the change event', () => {
    const seen: unknown[] = []
    const listener = (event: Event): void => { seen.push((event as CustomEvent).detail) }
    window.addEventListener(TRAINING_HOST_EVENT, listener)
    announceTrainingHost('ssh-2')
    window.removeEventListener(TRAINING_HOST_EVENT, listener)
    expect(seen).toEqual(['ssh-2'])
    expect(getSelectedTrainingHost()).toBe('ssh-2')
  })

  describe('resolveTrainingHost', () => {
    const hosts = [{ id: 'ssh-a', kind: 'ssh' }, { id: 'local-like', kind: 'local' }]
    it.each([
      [undefined, true, 'local'],
      [null, true, 'local'],
      ['', true, 'local'],
      ['local', true, 'local'],
      ['ssh-a', false, 'local'],
      ['ssh-a', true, 'ssh-a'],
      ['ssh-gone', true, 'local'],
      ['local-like', true, 'local'],
    ] as const)('id %s with remote=%s resolves to %s', (id, remote, expected) => {
      expect(resolveTrainingHost(id, hosts, remote)).toBe(expected)
    })
  })
})
