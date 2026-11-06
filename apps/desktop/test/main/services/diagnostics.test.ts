import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDataRoot } from '@test/helpers/tempDir'

const emitted: Array<{ channel: string; payload: unknown }> = []
vi.mock('@main/lib/events', () => ({ emit: (channel: string, payload: unknown) => emitted.push({ channel, payload }) }))
vi.mock('@main/lib/content', () => ({ contentDir: () => null }))

const root = useTempDataRoot()
const file = () => join(root(), 'diagnostics.json')

beforeEach(() => {
  vi.resetModules()
  emitted.length = 0
})
afterEach(() => vi.useRealTimers())
const load = () => import('@main/services/diagnostics')

function input(signature: string, patch: Record<string, unknown> = {}) {
  return { ruleId: 'E_NET', severity: 'warning' as const, title: 't', explain: 'e', solutions: [], raw: 'raw', signature, ...patch }
}

describe('pushDiagnostic', () => {
  it('records a new diagnostic, emits it and persists it', async () => {
    const { pushDiagnostic, listDiagnostics } = await load()
    const diagnostic = pushDiagnostic(input('sig-a'))
    expect(diagnostic).toMatchObject({ count: 1, toast: true, signature: 'sig-a' })
    expect(diagnostic.firstAt).toBe(diagnostic.lastAt)
    expect(emitted).toEqual([{ channel: 'event:diagnostic', payload: diagnostic }])
    expect(listDiagnostics()).toEqual([diagnostic])
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toHaveLength(1)
  })

  it('dedupes by signature: bumps the count, refreshes text, moves it to the front and never re-toasts', async () => {
    const { pushDiagnostic, listDiagnostics } = await load()
    const first = pushDiagnostic(input('sig-a'))
    pushDiagnostic(input('sig-b'))
    const again = pushDiagnostic(input('sig-a', { raw: 'new raw', title: 'T2', explain: 'E2' }))
    expect(again).toMatchObject({ id: first.id, count: 2, raw: 'new raw', title: 'T2', explain: 'E2', toast: false })
    expect(listDiagnostics().map((item) => item.signature)).toEqual(['sig-a', 'sig-b'])
    expect((emitted.at(-1)!.payload as { toast: boolean }).toast).toBe(false)
  })

  it('never toasts info, honours toast:false and rate-limits to 3 toasts per 5 minutes', async () => {
    vi.useFakeTimers()
    const { pushDiagnostic } = await load()
    expect(pushDiagnostic(input('i', { severity: 'info' })).toast).toBe(false)
    expect(pushDiagnostic(input('q', { toast: false })).toast).toBe(false)
    expect([1, 2, 3, 4].map((n) => pushDiagnostic(input(`s${n}`)).toast)).toEqual([true, true, true, false])
    vi.advanceTimersByTime(5 * 60_000 + 1)
    expect(pushDiagnostic(input('s5', { severity: 'error' })).toast).toBe(true)
  })

  it('keeps at most 200 diagnostics, newest first', async () => {
    const { pushDiagnostic, listDiagnostics } = await load()
    for (let index = 0; index < 205; index += 1) pushDiagnostic(input(`sig-${index}`, { toast: false }))
    const list = listDiagnostics()
    expect(list).toHaveLength(200)
    expect(list[0]!.signature).toBe('sig-204')
    expect(list.at(-1)!.signature).toBe('sig-5')
  })
})

describe('loading', () => {
  it('re-renders stored placeholder titles with the current rule', async () => {
    writeFileSync(
      file(),
      JSON.stringify([
        {
          id: '1',
          ruleId: 'E_MODULE',
          severity: 'error',
          title: '缺少 {1}',
          explain: '{1}',
          raw: "No module named 'xformers'",
          signature: 's',
          count: 1,
          firstAt: 'a',
          lastAt: 'a',
          toast: false,
          solutions: [],
        },
        {
          id: '2',
          ruleId: 'GONE',
          severity: 'error',
          title: 'keep {1}',
          explain: '',
          raw: '',
          signature: 's2',
          count: 1,
          firstAt: 'a',
          lastAt: 'a',
          toast: false,
          solutions: [],
        },
      ]),
    )
    const list = (await load()).listDiagnostics()
    // The fallback E_MODULE rule has no placeholder, so its fixed title replaces the stale template.
    expect(list[0]).toMatchObject({ title: '缺少 Python 包', explain: expect.not.stringContaining('{1}') })
    expect(list[1]!.title).toBe('keep {1}')
  })

  it('returns an empty list for corrupt or non-array files and caps loaded entries at 200', async () => {
    writeFileSync(file(), '{')
    expect((await load()).listDiagnostics()).toEqual([])
    vi.resetModules()
    writeFileSync(file(), JSON.stringify({}))
    expect((await load()).listDiagnostics()).toEqual([])
    vi.resetModules()
    writeFileSync(
      file(),
      JSON.stringify(Array.from({ length: 250 }, (_, index) => ({ id: String(index), title: '', explain: '', signature: String(index) }))),
    )
    expect((await load()).listDiagnostics()).toHaveLength(200)
  })
})

describe('dismiss / clear', () => {
  it('removes one or all diagnostics and persists', async () => {
    const { pushDiagnostic, dismissDiagnostic, clearDiagnostics, listDiagnostics } = await load()
    const a = pushDiagnostic(input('a'))
    pushDiagnostic(input('b'))
    dismissDiagnostic(a.id)
    expect(listDiagnostics().map((item) => item.signature)).toEqual(['b'])
    clearDiagnostics()
    expect(listDiagnostics()).toEqual([])
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual([])
  })

  it('returns copies from listDiagnostics', async () => {
    const { pushDiagnostic, listDiagnostics } = await load()
    pushDiagnostic(input('a'))
    listDiagnostics()[0]!.count = 99
    expect(listDiagnostics()[0]!.count).toBe(1)
  })
})
