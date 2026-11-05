import { describe, expect, it } from 'vitest'
import { Events, Ipc } from '@shared/channels'

const ipcValues = Object.values(Ipc)
const eventValues = Object.values(Events)

const duplicates = (values: string[]) => values.filter((value, index) => values.indexOf(value) !== index)

describe('Ipc channels', () => {
  it('has no duplicate channel strings', () => {
    expect(duplicates(ipcValues)).toEqual([])
  })

  it('namespaces every channel as `namespace:action` in kebab case', () => {
    for (const value of ipcValues) {
      expect(value).toMatch(/^[a-z][a-z-]*:[a-z][a-z-]*$/)
    }
  })

  it('never uses the event namespace', () => {
    expect(ipcValues.filter((value) => value.startsWith('event:'))).toEqual([])
  })
})

describe('Event channels', () => {
  it('has no duplicate channel strings', () => {
    expect(duplicates(eventValues)).toEqual([])
  })

  it('namespaces every event under `event:` in kebab case', () => {
    for (const value of eventValues) {
      expect(value).toMatch(/^event:[a-z][a-z-]*$/)
    }
  })
})

describe('Ipc and Events together', () => {
  it('never reuse a channel string across request and event channels', () => {
    expect(duplicates([...ipcValues, ...eventValues])).toEqual([])
  })

  it('only contain string values', () => {
    for (const value of [...ipcValues, ...eventValues]) expect(typeof value).toBe('string')
  })

  it('keep keys and values one-to-one', () => {
    expect(new Set(ipcValues).size).toBe(Object.keys(Ipc).length)
    expect(new Set(eventValues).size).toBe(Object.keys(Events).length)
  })
})
