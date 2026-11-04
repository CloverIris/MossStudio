import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { firstLine, run, runStream, tail } from '@main/lib/run'

// These tests spawn the Node binary running the test itself: a known, local
// executable, so run/runStream are exercised end to end without external tools.
const node = process.execPath
const script = (source: string): string[] => ['-e', source]

describe('run', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const result = await run(node, script('process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'))
    expect(result).toEqual({ code: 3, stdout: 'out', stderr: 'err', timedOut: false })
  })

  it('passes input on stdin and merges env over process.env', async () => {
    const result = await run(node, script('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(d+process.env.RUN_TEST_VAR))'), {
      input: 'hello-', env: { RUN_TEST_VAR: 'world' },
    })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('hello-world')
  })

  it('kills and flags a process that exceeds the timeout', async () => {
    const result = await run(node, script('setTimeout(() => {}, 10000)'), { timeoutMs: 200 })
    expect(result.timedOut).toBe(true)
    expect(result.code).toBe(-1)
  })

  it('resolves code -1 with the error when the binary does not exist', async () => {
    const result = await run('/nonexistent/definitely-not-a-binary', [])
    expect(result.code).toBe(-1)
    expect(result.stderr).toMatch(/ENOENT/)
    expect(result.timedOut).toBe(false)
  })

  it('honours cwd', async () => {
    // Not '/': on Windows that is the current drive's root (D:\\), not a portable value.
    const cwd = realpathSync.native(tmpdir())
    const result = await run(node, script('console.log(process.cwd())'), { cwd })
    expect(realpathSync.native(result.stdout.trim())).toBe(cwd)
  })
})

describe('runStream', () => {
  it('emits each non-blank line per stream, including a trailing partial line', async () => {
    const lines: Array<[string, string]> = []
    const result = await runStream(node, script('process.stdout.write("a\\n\\nb\\r\\nc"); process.stderr.write("e1\\n")'), {}, (line, stream) => lines.push([line, stream]))
    expect(result.code).toBe(0)
    expect(lines.filter(([, s]) => s === 'stdout').map(([l]) => l)).toEqual(['a', 'b', 'c'])
    expect(lines.filter(([, s]) => s === 'stderr').map(([l]) => l)).toEqual(['e1'])
    expect(result.stdout).toBe('a\n\nb\r\nc')
  })

  it('handles lines split across chunks', async () => {
    const lines: string[] = []
    await runStream(node, script('process.stdout.write("hel"); setTimeout(() => process.stdout.write("lo\\nworld\\n"), 30)'), {}, (line) => lines.push(line))
    expect(lines).toEqual(['hello', 'world'])
  })

  it('feeds input when provided and times out long runs', async () => {
    const lines: string[] = []
    const echoed = await runStream(node, script('process.stdin.pipe(process.stdout)'), { input: 'x\ny\n' }, (line) => lines.push(line))
    expect(echoed.code).toBe(0)
    expect(lines).toEqual(['x', 'y'])
    const slow = await runStream(node, script('setTimeout(() => {}, 10000)'), { timeoutMs: 200 }, () => undefined)
    expect(slow.timedOut).toBe(true)
  })

  it('resolves code -1 when the binary is missing', async () => {
    const result = await runStream('/nonexistent/definitely-not-a-binary', [], {}, () => undefined)
    expect(result.code).toBe(-1)
  })
})

describe('firstLine / tail', () => {
  it('firstLine trims and takes the first line', () => {
    expect(firstLine('  \n first\r\nsecond')).toBe('first')
    expect(firstLine('')).toBe('')
  })

  it('tail keeps the last N lines', () => {
    const text = Array.from({ length: 20 }, (_, index) => `l${index}`).join('\n')
    expect(tail(text).split('\n')).toHaveLength(12)
    expect(tail(text, 2)).toBe('l18\nl19')
    expect(tail('\n\nonly\n\n')).toBe('only')
  })
})
