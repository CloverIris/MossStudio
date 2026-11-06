import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDir } from '@test/helpers/tempDir'

const release = { dir: null as string | null }
vi.mock('@main/lib/content', () => ({ contentDir: () => release.dir }))

const temp = useTempDir()

beforeEach(() => {
  vi.resetModules()
  release.dir = null
})
const load = () => import('@main/services/parsers')

describe('stripAnsi', () => {
  it('removes CSI colour codes and OSC title sequences', async () => {
    const { stripAnsi } = await load()
    expect(stripAnsi('\u001b[31mred\u001b[0m \u001b[?25lplain\u001b]0;title\u0007!')).toBe('red plain!')
  })
})

describe('LineSplitter', () => {
  it('splits on LF, CRLF and bare CR, buffering the partial tail', async () => {
    const { LineSplitter } = await load()
    const splitter = new LineSplitter()
    expect(splitter.push('a\nb\r\nc\rpar')).toEqual(['a', 'b', 'c'])
    expect(splitter.push('tial\n\n   \nnext')).toEqual(['partial'])
    expect(splitter.flush()).toEqual(['next'])
    expect(splitter.flush()).toEqual([])
  })

  it('drops a whitespace-only remainder on flush', async () => {
    const { LineSplitter } = await load()
    const splitter = new LineSplitter()
    splitter.push('   ')
    expect(splitter.flush()).toEqual([])
  })
})

describe('parseTqdm', () => {
  it('parses percent, counts, eta and rate', async () => {
    const { parseTqdm } = await load()
    expect(parseTqdm(' 40%|████      | 20/50 [00:10<00:15,  2.00it/s]')).toEqual({
      percent: 40,
      current: 20,
      total: 50,
      etaMs: 15_000,
      rate: '2.00it/s',
    })
  })

  it('handles h:mm:ss eta and a missing rate', async () => {
    const { parseTqdm } = await load()
    expect(parseTqdm('10%|#| 1/10 [00:01<1:02:03]')).toMatchObject({ etaMs: (3600 + 120 + 3) * 1000, rate: undefined })
  })

  it('leaves etaMs undefined for unknown eta text', async () => {
    const { parseTqdm } = await load()
    expect(parseTqdm('10%|#| 1/10 [00:01<?, ?it/s]')?.etaMs).toBeUndefined()
  })

  it('derives the percent from the counts when the printed percent is 0, and clamps to 100', async () => {
    const { parseTqdm } = await load()
    expect(parseTqdm('0%|| 1/4 [00:00<00:01]')?.percent).toBe(25)
    expect(parseTqdm('150%|| 3/2 [00:00<00:00]')?.percent).toBe(100)
  })

  it('rejects non-tqdm lines and zero totals', async () => {
    const { parseTqdm } = await load()
    expect(parseTqdm('Loading model...')).toBeNull()
    expect(parseTqdm('0%|| 0/0 [00:00<00:00]')).toBeNull()
  })
})

describe('parseDownloadProgress', () => {
  it('parses huggingface-style byte progress', async () => {
    const { parseDownloadProgress } = await load()
    expect(parseDownloadProgress('model.safetensors:  42%|████ | 1.2G/2.9G [00:10<00:12]')).toEqual({
      percent: 42,
      current: 0,
      total: 0,
      label: 'model.safetensors',
      rate: '1.2G / 2.9G',
    })
    expect(parseDownloadProgress('no progress here')).toBeNull()
  })
})

describe('progressFor', () => {
  const base = { stage: 'denoise' as const, current: 30, total: 50, percent: 60 }

  it('maps idle/ready to denoise and copies the parsed values', async () => {
    const { progressFor } = await load()
    expect(progressFor('20%|| 10/50 [00:01<00:04, 9it/s]', 'idle', { ...base, stage: 'load' as never })).toEqual({
      stage: 'denoise',
      current: 10,
      total: 50,
      percent: 20,
      etaMs: 4000,
      message: '9it/s',
    })
  })

  it('never goes backwards within one stage but resets on a new stage', async () => {
    const { progressFor } = await load()
    expect(progressFor('20%|| 10/50 [00:01<00:04]', 'denoise', base)).toMatchObject({ percent: 60, current: 30 })
    expect(progressFor('20%|| 10/50 [00:01<00:04]', 'decode' as never, base)).toMatchObject({ stage: 'decode', percent: 20, current: 10 })
  })

  it('returns null for non-progress lines', async () => {
    const { progressFor } = await load()
    expect(progressFor('hello', 'denoise', base)).toBeNull()
  })
})

describe('rules', () => {
  it('uses the built-in fallback rules without a release directory', async () => {
    const { loadRules, matchRule, exitRule } = await load()
    expect(loadRules().map((rule) => rule.id)).toEqual(['E_EXIT', 'E_OOM', 'E_MODULE', 'E_NET'])
    expect(matchRule('torch.OutOfMemoryError: CUDA out of memory')?.id).toBe('E_OOM')
    expect(matchRule('requests.exceptions.SSLError: bad handshake')?.id).toBe('E_NET')
    expect(matchRule('all good')).toBeNull()
    expect(exitRule().id).toBe('E_EXIT')
  })

  it('loads rules.json from the release directory and skips invalid regexes', async () => {
    release.dir = temp()
    writeFileSync(
      join(temp(), 'rules.json'),
      JSON.stringify({
        rules: [
          { id: 'BAD', match: '([', severity: 'error', title: 't', explain: 'e' },
          { id: 'CUSTOM', match: 'kaboom', severity: 'warning', title: 'Custom', explain: 'x' },
        ],
      }),
    )
    const { loadRules, matchRule, exitRule } = await load()
    const rules = loadRules()
    expect(rules.map((rule) => rule.id)).toEqual(['BAD', 'CUSTOM'])
    expect(rules[0]!.regex).toBeUndefined()
    expect(matchRule('KABOOM happened')?.id).toBe('CUSTOM')
    // A rule set without E_EXIT still provides the built-in exit rule.
    expect(exitRule().id).toBe('E_EXIT')
  })

  it('falls back when rules.json is corrupt or empty', async () => {
    release.dir = temp()
    writeFileSync(join(temp(), 'rules.json'), '{')
    expect((await load()).loadRules()).toHaveLength(4)
    vi.resetModules()
    writeFileSync(join(temp(), 'rules.json'), JSON.stringify({ rules: [] }))
    expect((await load()).loadRules()).toHaveLength(4)
  })

  it('caches the rule set for 30 seconds', async () => {
    vi.useFakeTimers()
    try {
      release.dir = temp()
      mkdirSync(temp(), { recursive: true })
      const write = (id: string) =>
        writeFileSync(join(temp(), 'rules.json'), JSON.stringify({ rules: [{ id, match: id, severity: 'info', title: id, explain: id }] }))
      write('FIRST')
      const { loadRules } = await load()
      expect(loadRules()[0]!.id).toBe('FIRST')
      write('SECOND')
      vi.advanceTimersByTime(29_000)
      expect(loadRules()[0]!.id).toBe('FIRST')
      vi.advanceTimersByTime(2_000)
      expect(loadRules()[0]!.id).toBe('SECOND')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('normalizeSignature', () => {
  it('collapses urls, paths, hashes and numbers so repeats share one signature', async () => {
    const { normalizeSignature } = await load()
    const a = normalizeSignature('E_NET', 'Failed https://a.example/x?1 at /tmp/run-1/file.py commit abcdef1234 after 3 tries')
    const b = normalizeSignature('E_NET', 'failed https://b.example/y at /var/other.py commit 0123456789abcdef after 12 tries')
    expect(a).toBe(b)
    expect(a).toBe('E_NET:failed <url> at <path> commit <hash> after # tries')
  })

  it('normalises Windows paths and whitespace and caps the length', async () => {
    const { normalizeSignature } = await load()
    expect(normalizeSignature('R', 'C:\\Users\\me\\x.py   broke')).toBe('R:<path> broke')
    expect(normalizeSignature('R', 'x'.repeat(500))).toHaveLength('R:'.length + 240)
  })
})

describe('toDiagnostic', () => {
  it('renders numbered capture groups into title and explain', async () => {
    const { toDiagnostic } = await load()
    const rule = {
      id: 'E_MODULE',
      match: "No module named '([^']+)'",
      regex: /No module named '([^']+)'/i,
      severity: 'error' as const,
      title: '缺少 {1}',
      explain: '{1} / {2}',
      solutions: [{ label: 'fix', action: 'repair_runtime', params: { a: 1 } }],
    }
    const diagnostic = toDiagnostic(rule, "ModuleNotFoundError: No module named 'torch'", 'job-1')
    expect(diagnostic).toMatchObject({
      jobId: 'job-1',
      ruleId: 'E_MODULE',
      severity: 'error',
      title: '缺少 torch',
      explain: 'torch / 未知',
      solutions: [{ label: 'fix', action: 'repair_runtime', params: { a: 1 } }],
    })
    expect(diagnostic.signature.startsWith('E_MODULE:')).toBe(true)
  })

  it('adds a copy action when the rule has no solutions and keeps the last 4000 chars', async () => {
    const { toDiagnostic, exitRule } = await load()
    const raw = `${'a'.repeat(5000)}END`
    const diagnostic = toDiagnostic(exitRule(), raw)
    expect(toDiagnostic({ ...exitRule(), solutions: [] }, 'x').solutions).toEqual([{ label: '复制诊断信息', action: 'copy_diagnostics' }])
    expect(diagnostic.raw).toHaveLength(4000)
    expect(diagnostic.raw.endsWith('END')).toBe(true)
    expect(diagnostic.title).toBe('程序异常退出')
  })
})
