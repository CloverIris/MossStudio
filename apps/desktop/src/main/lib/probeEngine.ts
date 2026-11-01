import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { extname } from 'node:path'
import {
  decodeEngineHello,
  ENGINE_PROTOCOL_VERSION,
  type EngineHello,
} from '@shared/engineProtocol'

export function spawnEngineServer(
  serverPath: string,
  args: string[] = [],
  extraEnv?: Record<string, string>,
): ChildProcessWithoutNullStreams {
  const isJavaScript = ['.js', '.cjs', '.mjs'].includes(extname(serverPath).toLowerCase())
  const command = isJavaScript ? process.execPath : serverPath
  const commandArgs = isJavaScript ? [serverPath, ...args] : args
  return spawn(command, commandArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      ...extraEnv,
      ...(isJavaScript ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  })
}

/** 启动一次性 sidecar，完成带设备枚举的 hello 后关闭。 */
export async function probeEngine(
  serverPath: string,
  options: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<EngineHello> {
  const proc = spawnEngineServer(serverPath, [], options.env)
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('moss-server hello 超时')), options.timeoutMs ?? 30_000)
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => {
        const lines = (buffer + chunk).split(/\r\n|\n|\r/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          let message: Record<string, unknown>
          try {
            message = JSON.parse(line) as Record<string, unknown>
          } catch {
            continue
          }
          if (message.id !== 'probe') continue
          clearTimeout(timer)
          const error = message.error as { message?: string } | undefined
          if (error) reject(new Error(error.message ?? 'hello 失败'))
          else resolve(message.result ?? {})
        }
      })
      proc.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        reject(new Error(`moss-server 退出 (code ${code ?? 'null'})，未完成 hello`))
      })
      proc.stdin.write(`${JSON.stringify({
        id: 'probe',
        method: 'hello',
        params: { client: 'MossStudio', protocol_version: ENGINE_PROTOCOL_VERSION, devices: true },
      })}\n`)
    })
    return decodeEngineHello(raw)
  } finally {
    try {
      proc.stdin.write(`${JSON.stringify({ id: 'bye', method: 'shutdown' })}\n`)
    } catch {
      // 进程可能已经退出。
    }
    setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // 进程可能已经退出。
      }
    }, 2000).unref()
  }
}
