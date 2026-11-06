/**
 * Which of our child processes a silent setup/uninstall must kill before app.exit(): ONLY
 * Chromium's own helpers (GPU process, its broker, utilities, zygotes, crashpad), never a
 * process we started on purpose (the temp launcher running --finish-uninstall, the installed
 * launcher, `open -n`, the DMG eject script) nor anything below one. Detached children keep
 * us as their parent until we exit, so plain ancestry would include them.
 *
 * Two independent checks, both required:
 *   1. pids we spawned deliberately are recorded (`rememberSpawned`), and they and their
 *      whole subtrees are excluded;
 *   2. a process is killed only when its executable is our own Chromium binary
 *      (Linux: process.execPath, or chrome-sandbox / chrome_crashpad_handler beside it;
 *      macOS: the main executable or a "MossStudio Helper*" inside Contents/Frameworks).
 * Linux reads /proc, macOS asks `ps`. Windows has no cheap table here and relies on
 * app.getAppMetrics() (Chromium's processes only); Chromium's job object ends them anyway.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import path from 'node:path'

export interface ProcessEntry {
  pid: number
  ppid: number
  /** Absolute path of the executable, when readable. */
  exe: string | null
}

const spawned = new Set<number>()

/** Record a process we start on purpose; it and its children are never killed on exit. */
export function rememberSpawned(pid: number | undefined): void {
  if (typeof pid === 'number' && pid > 0) spawned.add(pid)
}

export function spawnedPids(): ReadonlySet<number> {
  return spawned
}

/** pid and ppid from a /proc/<pid>/stat line; comm may hold spaces and parentheses. */
export function parseProcStat(text: string): Omit<ProcessEntry, 'exe'> | null {
  const close = text.lastIndexOf(')')
  const pid = Number.parseInt(text, 10)
  if (close < 0 || !Number.isFinite(pid)) return null
  const fields = text.slice(close + 2).split(' ')
  const ppid = Number.parseInt(fields[1] ?? '', 10)
  return Number.isFinite(ppid) ? { pid, ppid } : null
}

/** `ps -axo pid=,ppid=,comm=` output; comm (the executable path) may contain spaces. */
export function parsePsTable(text: string): ProcessEntry[] {
  const out: ProcessEntry[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line)
    if (!match) continue
    out.push({ pid: Number(match[1]), ppid: Number(match[2]), exe: match[3]?.trim() || null })
  }
  return out
}

/** Is `exe` one of our own Chromium executables? */
export function isChromiumHelper(platform: NodeJS.Platform, exe: string | null, execPath: string): boolean {
  if (!exe) return false
  if (platform === 'darwin') {
    if (exe === execPath) return true
    const marker = '.app/Contents/MacOS/'
    const at = execPath.lastIndexOf(marker)
    if (at < 0) return false
    const frameworks = `${execPath.slice(0, at)}.app/Contents/Frameworks/`
    const rel = exe.startsWith(frameworks) ? exe.slice(frameworks.length) : null
    return rel !== null && /^[^/]+ Helper[^/]*\.app\/Contents\/MacOS\//.test(rel)
  }
  const p = platform === 'win32' ? path.win32 : path.posix
  if (exe === execPath) return true
  return p.dirname(exe) === p.dirname(execPath) && ['chrome-sandbox', 'chrome_crashpad_handler'].includes(p.basename(exe))
}

/**
 * The Chromium helpers below `root` to kill: walk down from `root` through our own Chromium
 * processes only, never entering an excluded pid (one we spawned) or a foreign executable.
 */
export function helpersToKill(
  root: number,
  table: ProcessEntry[],
  exclude: ReadonlySet<number>,
  isOurs: (entry: ProcessEntry) => boolean,
): number[] {
  const children = new Map<number, ProcessEntry[]>()
  for (const entry of table) {
    if (entry.pid === entry.ppid) continue
    const list = children.get(entry.ppid) ?? []
    list.push(entry)
    children.set(entry.ppid, list)
  }
  const found: number[] = []
  const seen = new Set<number>([root])
  const queue = [root]
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      if (exclude.has(child.pid) || !isOurs(child)) continue
      found.push(child.pid)
      queue.push(child.pid)
    }
  }
  return found
}

function linuxExe(pid: string): string | null {
  try {
    return readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '')
  } catch {
    return null
  }
}

/** The process table of this machine, or [] where there is none to read. */
export function processTable(platform: NodeJS.Platform = process.platform): ProcessEntry[] {
  try {
    if (platform === 'linux') {
      const out: ProcessEntry[] = []
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue
        try {
          const entry = parseProcStat(readFileSync(`/proc/${name}/stat`, 'utf8'))
          if (entry) out.push({ ...entry, exe: linuxExe(name) })
        } catch {
          // exited meanwhile
        }
      }
      return out
    }
    if (platform === 'darwin')
      return parsePsTable(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 5000 }))
  } catch {
    // no table: app.getAppMetrics() alone
  }
  return []
}

/** Our Chromium helpers right now (the caller adds app.getAppMetrics()' pids, minus spawned ones). */
export function chromiumHelpers(platform: NodeJS.Platform = process.platform, execPath: string = process.execPath): number[] {
  return helpersToKill(process.pid, processTable(platform), spawned, (entry) => isChromiumHelper(platform, entry.exe, execPath))
}
