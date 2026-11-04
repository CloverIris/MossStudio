import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Windows and default macOS file systems ignore case: `Board.tsx` and `board.ts` are the
// same module there (`./Board` resolves to either), which breaks the Windows build.
function moduleNames(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) moduleNames(path, out)
    else if (/\.(tsx?|mts|cts|jsx?|mjs|cjs)$/.test(entry.name)) out.push(path.replace(/\.(tsx?|mts|cts|jsx?|mjs|cjs)$/, ''))
  }
  return out
}

describe('source tree', () => {
  it('has no module names that differ only in letter case', () => {
    const root = resolve(__dirname, '../../..')
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const dir of ['src', 'test', 'e2e']) {
      for (const name of moduleNames(join(root, dir))) {
        const key = name.toLowerCase()
        const other = seen.get(key)
        if (other && other !== name) clashes.push(`${other} <-> ${name}`)
        seen.set(key, name)
      }
    }
    expect(clashes).toEqual([])
  })
})
