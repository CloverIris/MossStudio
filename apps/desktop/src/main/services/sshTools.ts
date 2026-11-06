import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'

interface SshTools {
  ssh: string
  scp: string
  keyscan: string
  shell?: string
}

let detected: SshTools | undefined

function gitSuite(directory: string): SshTools | undefined {
  if (!['ssh.exe', 'scp.exe', 'ssh-keyscan.exe', 'sh.exe'].every((name) => existsSync(win32.join(directory, name)))) return
  return {
    ssh: win32.join(directory, 'ssh.exe'),
    scp: win32.join(directory, 'scp.exe'),
    keyscan: win32.join(directory, 'ssh-keyscan.exe'),
    shell: win32.join(directory, 'sh.exe'),
  }
}

function detectTools(): SshTools {
  const system = { ssh: 'ssh', scp: 'scp', keyscan: 'ssh-keyscan' }
  if (process.platform !== 'win32') return system
  const env = process.env
  const path = Object.entries(env).find(([name]) => name.toLowerCase() === 'path')?.[1] ?? ''
  for (const entry of path.split(';')) {
    const directory = entry.trim().replace(/^"|"$/g, '')
    if (!directory) continue
    const git = win32.join(directory, 'git.exe')
    if (!existsSync(git)) continue
    let real = git
    try {
      real = realpathSync(git)
    } catch {
      /* use the PATH entry */
    }
    for (const bin of new Set([directory, win32.dirname(real)])) {
      for (const candidate of [bin, win32.resolve(bin, '../usr/bin'), win32.resolve(bin, '../../usr/bin')]) {
        const suite = gitSuite(candidate)
        if (suite) return suite
      }
    }
  }
  // The installer records custom locations even when Git is absent from PATH.
  for (const key of ['HKCU\\Software\\GitForWindows', 'HKLM\\Software\\GitForWindows', 'HKLM\\Software\\WOW6432Node\\GitForWindows']) {
    const result = spawnSync('reg.exe', ['query', key, '/v', 'InstallPath'], { encoding: 'utf8', windowsHide: true, timeout: 2000 })
    const root = result.stdout?.match(/InstallPath\s+REG_SZ\s+(.+)/i)?.[1]?.trim()
    const suite = root ? gitSuite(win32.join(root, 'usr/bin')) : undefined
    if (suite) return suite
  }
  const roots = [
    env['ProgramW6432'] && win32.join(env['ProgramW6432'], 'Git'),
    env['ProgramFiles'] && win32.join(env['ProgramFiles'], 'Git'),
    env['ProgramFiles(x86)'] && win32.join(env['ProgramFiles(x86)'], 'Git'),
    env['LOCALAPPDATA'] && win32.join(env['LOCALAPPDATA'], 'Programs/Git'),
    env['LOCALAPPDATA'] && win32.join(env['LOCALAPPDATA'], 'Git'),
    env['USERPROFILE'] && win32.join(env['USERPROFILE'], 'scoop/apps/git/current'),
  ]
  for (const root of roots) {
    const suite = root ? gitSuite(win32.join(root, 'usr/bin')) : undefined
    if (suite) return suite
  }
  const directory = win32.join(env['SystemRoot'] || 'C:\\Windows', 'System32/OpenSSH')
  if (['ssh.exe', 'scp.exe', 'ssh-keyscan.exe'].every((name) => existsSync(win32.join(directory, name)))) {
    return {
      ssh: win32.join(directory, 'ssh.exe'),
      scp: win32.join(directory, 'scp.exe'),
      keyscan: win32.join(directory, 'ssh-keyscan.exe'),
    }
  }
  return system
}

export function getSshTools(): SshTools {
  detected ??= detectTools()
  const ssh = process.env['CLOVER_SSH_BIN']
  const sibling = (name: string): string => {
    const candidate = join(dirname(ssh!), process.platform === 'win32' ? `${name}.exe` : name)
    return existsSync(candidate) ? candidate : name
  }
  const shell =
    ssh && process.platform === 'win32' && existsSync(join(dirname(ssh), 'msys-2.0.dll')) ? join(dirname(ssh), 'sh.exe') : undefined
  return {
    ssh: ssh || detected.ssh,
    scp: process.env['CLOVER_SCP_BIN'] || (ssh ? sibling('scp') : detected.scp),
    keyscan: process.env['CLOVER_SSH_KEYSCAN_BIN'] || (ssh ? sibling('ssh-keyscan') : detected.keyscan),
    shell: ssh ? shell : detected.shell,
  }
}

/** MSYS scp treats a native drive colon as a remote host separator. */
export function sshLocalPath(path: string): string {
  if (process.platform !== 'win32' || !getSshTools().shell) return path
  const forward = path.replace(/\\/g, '/')
  return forward.replace(/^([A-Za-z]):\//, (_, drive: string) => `/${drive.toLowerCase()}/`)
}
