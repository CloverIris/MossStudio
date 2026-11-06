import { spawn } from 'node:child_process'

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  input?: string
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error), timedOut: false })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child?.kill('SIGKILL')
    }, options.timeoutMs ?? 15_000)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr || String(error), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })

    // SSH can exit before consuming a worker upload/request. Its exit/error
    // handlers report the failure; a broken stdin must not crash the launcher.
    child.stdin?.on('error', () => undefined)
    if (options.input) child.stdin?.end(options.input)
    else child.stdin?.end()
  })
}

export function runStream(
  command: string,
  args: string[],
  options: RunOptions,
  onLine: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs ?? 3_600_000)

    const pipe = (stream: 'stdout' | 'stderr', source: NodeJS.ReadableStream | null): void => {
      let buffer = ''
      source?.setEncoding('utf8')
      source?.on('data', (chunk: string) => {
        if (stream === 'stdout') stdout += chunk
        else stderr += chunk
        buffer += chunk
        const parts = buffer.split(/\r?\n/)
        buffer = parts.pop() ?? ''
        for (const line of parts) {
          if (line.trim()) onLine(line, stream)
        }
      })
      source?.on('end', () => {
        if (buffer.trim()) onLine(buffer, stream)
      })
    }
    pipe('stdout', child.stdout)
    pipe('stderr', child.stderr)

    child.stdin?.on('error', () => undefined)
    child.stdin?.end(options.input)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr || String(error), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

export function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? ''
}

export function tail(text: string, lines = 12): string {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n')
}
