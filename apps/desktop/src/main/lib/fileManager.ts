import { spawn } from 'node:child_process'
import { shell } from 'electron'

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

async function runWindowsShell(script: string): Promise<void> {
  const systemRoot = process.env['SystemRoot']
  const executable = systemRoot
    ? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe'
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'try {',
    ...script.split('\n').map((line) => `  ${line}`),
    '  exit 0',
    '} catch {',
    '  [Console]::Out.WriteLine("MOSSSTUDIO_ERROR:" + $_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n')
  const encoded = Buffer.from(command, 'utf16le').toString('base64')

  await new Promise<void>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      const error = stdout.match(/MOSSSTUDIO_ERROR:(.+)/)?.[1]?.trim()
      reject(new Error(error || stderr.trim() || `Windows 文件管理器启动失败（退出码 ${code ?? 'unknown'}）`))
    })
  })
}

export async function openDirectoryInFileManager(directory: string): Promise<void> {
  if (process.platform === 'win32') {
    await runWindowsShell([
      '$fileManager = New-Object -ComObject Shell.Application',
      `$target = ${powershellLiteral(directory)}`,
      '$fileManager.ShellExecute($target, \'\', \'\', \'open\', 1)',
    ].join('\n'))
    return
  }
  const error = await shell.openPath(directory)
  if (error) throw new Error(`无法打开目录：${error}`)
}

export async function revealInFileManager(target: string): Promise<void> {
  if (process.platform === 'win32') {
    const explorer = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\explorer.exe`
    await runWindowsShell([
      '$fileManager = New-Object -ComObject Shell.Application',
      `$fileManager.ShellExecute(${powershellLiteral(explorer)}, ${powershellLiteral(`/select,"${target}"`)}, '', 'open', 1)`,
    ].join('\n'))
    return
  }
  shell.showItemInFolder(target)
}
