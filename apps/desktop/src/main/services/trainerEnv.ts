import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '@shared/types'
import { firstLine, run } from '../lib/run'
import { pythonVersion } from '../lib/python'

export function venvPython(dir: string): string {
  return process.platform === 'win32' ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python3')
}

async function which(name: string): Promise<string | null> {
  const result = await run(process.platform === 'win32' ? 'where' : 'which', [name], { timeoutMs: 3000 })
  return result.code === 0 ? firstLine(result.stdout) || null : null
}

/** Python discovery is scoped to Trainer, not inference. */
export async function pickPython(settings: Settings): Promise<{ path: string; version: string }> {
  if (settings.pythonPath) {
    const version = await pythonVersion(settings.pythonPath)
    if (version) return { path: settings.pythonPath, version }
  }
  if (process.platform === 'win32') {
    const py = await which('py')
    if (py) {
      const located = await run(py, ['-3', '-c', 'import sys;print(sys.executable)'], { timeoutMs: 5000 })
      const path = firstLine(located.stdout)
      const version = path ? await pythonVersion(path) : null
      if (version) return { path, version }
    }
  }
  for (const name of ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python']) {
    const path = await which(name)
    if (!path) continue
    const version = await pythonVersion(path)
    if (version) return { path, version }
  }
  if (process.platform === 'win32') {
    const roots = [
      process.env['LOCALAPPDATA'] ? join(process.env['LOCALAPPDATA'], 'Programs', 'Python') : '',
      process.env['ProgramFiles'] ? join(process.env['ProgramFiles'], 'Python') : '',
      'C:\\Python312', 'C:\\Python311', 'C:\\Python310',
    ].filter(Boolean)
    for (const root of roots) {
      const candidates = [root]
      try {
        for (const entry of await readdir(root, { withFileTypes: true })) {
          if (entry.isDirectory() && /^Python3\d+$/.test(entry.name)) candidates.push(join(root, entry.name))
        }
      } catch { /* missing root */ }
      for (const candidate of candidates) {
        const path = join(candidate, 'python.exe')
        const version = await pythonVersion(path)
        if (version) return { path, version }
      }
    }
  }
  throw new Error('Trainer 需要 Python 3.10+。请在 Trainer 设置中指定解释器。')
}

export function parseTrainerDeps(versionDir: string): string[] {
  try {
    const text = readFileSync(join(versionDir, 'pyproject.toml'), 'utf8')
    const project = text.match(/\[project\][\s\S]*?(?=\n\[|$)/)
    if (!project) return []
    const start = project[0].search(/dependencies\s*=\s*\[/)
    if (start < 0) return []
    // Walk the array: a `]` inside a quoted requirement (e.g. "diffusers[torch]") does not end it.
    const body = project[0].slice(project[0].indexOf('[', start) + 1)
    const deps: string[] = []
    for (let index = 0; index < body.length; index += 1) {
      const char = body[index]!
      if (char === ']') break
      if (char === '#') {
        const newline = body.indexOf('\n', index)
        if (newline < 0) break
        index = newline
      } else if (char === '"' || char === "'") {
        const end = body.indexOf(char, index + 1)
        if (end < 0) break
        deps.push(body.slice(index + 1, end))
        index = end
      }
    }
    return deps
  } catch {
    return []
  }
}

export async function hasUv(): Promise<boolean> {
  return spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0
}
