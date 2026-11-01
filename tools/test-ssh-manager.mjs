import assert from 'node:assert/strict'
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { test } from 'node:test'

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const key = randomBytes(32)
const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'test',
  encryptString(value) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), data])
  },
  decryptString(value) {
    const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
    cipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8')
  },
}

function loadTs(path, mocks) {
  const filename = new URL(`../apps/desktop/src/${path}.ts`, import.meta.url)
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'process', outputText)((name) => {
    if (name in mocks) return mocks[name]
    return require(name)
  }, module, module.exports, mocks.process ?? process)
  return module.exports
}

function fixture(check) {
  const root = mkdtempSync(join(tmpdir(), 'clover-ssh-'))
  const paths = { root: () => root, cache: () => join(root, 'cache'), trainerRoot: () => root, instances: () => root, models: () => root }
  const credentials = loadTs('main/services/sshCredentials', { electron: { safeStorage }, '../lib/paths': { paths } })
  const calls = []
  const state = { scan: '', error: '', response: 0, dialogs: [] }
  const sshTools = { getSshTools: () => ({ ssh: 'ssh', scp: 'scp', keyscan: 'ssh-keyscan' }), sshLocalPath: (path) => path }
  const run = async (...args) => {
    calls.push(args)
    if (args[0] === 'ssh-keyscan') return { code: 0, stdout: state.scan, stderr: '', timedOut: false }
    if (state.error) { const error = state.error; state.error = ''; return { code: 255, stdout: '', stderr: error, timedOut: false } }
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  const hostKeys = loadTs('main/services/sshHostKeys', {
    electron: { dialog: { showMessageBox: async (options) => { state.dialogs.push(options); return { response: state.response } } } },
    '../lib/paths': { paths }, '../lib/run': { run }, './sshTools': sshTools,
  })
  const ssh = loadTs('main/services/ssh', { '../lib/paths': { paths }, './sshCredentials': credentials, './sshHostKeys': hostKeys, './sshTools': sshTools, '../lib/run': { run, runStream: run } })
  const hostMocks = { '../lib/paths': { paths }, '../lib/run': { run }, './devices': { listDevices: () => [] }, './ssh': ssh, './sshCredentials': credentials, './sshHostKeys': hostKeys, './hfCredentials': { hasHfToken: () => false, saveHfToken: () => {} } }
  const hosts = loadTs('main/services/trainingHosts', hostMocks)
  return Promise.resolve().then(() => check({ root, credentials, ssh, hosts, hostKeys, state, calls, reloadHosts: () => loadTs('main/services/trainingHosts', hostMocks) }))
    .finally(() => rmSync(root, { recursive: true, force: true }))
}

const input = { name: 'Fixture', host: '127.0.0.1', user: 'fixture', port: 2222, trainerRoot: '~/trainer' }
const host = { ...input, id: 'fixture', kind: 'ssh', status: 'unchecked' }

function toolsFixture({ env = {}, files = [], registry = {}, platform = 'win32', realpath = (path) => path } = {}) {
  const probes = []
  const available = new Set(files.map((path) => win32.normalize(path).toLowerCase()))
  const tools = loadTs('main/services/sshTools', {
    process: { platform, env },
    'node:fs': { existsSync: (path) => available.has(win32.normalize(path).toLowerCase()), realpathSync: realpath },
    'node:child_process': { spawnSync: (command, args) => {
      probes.push({ command, args })
      return { stdout: registry[args[1]] ? `InstallPath    REG_SZ    ${registry[args[1]]}\r\n` : '' }
    } },
  })
  return { ...tools, probes }
}

const suiteFiles = (root) => ['ssh.exe', 'scp.exe', 'ssh-keyscan.exe', 'sh.exe', 'msys-2.0.dll'].map((name) => win32.join(root, 'usr/bin', name))

test('finds Git on PATH in custom locations with spaces and keeps the SSH suite together', () => {
  const root = 'D:\\Developer Tools\\Git'
  const tools = toolsFixture({ env: { Path: 'C:\\Windows\\System32;"D:\\Developer Tools\\Git\\cmd"' }, files: [win32.join(root, 'cmd/git.exe'), ...suiteFiles(root)] })
  const selected = tools.getSshTools()
  assert.equal(selected.ssh, win32.join(root, 'usr/bin/ssh.exe'))
  assert.equal(selected.scp, win32.join(root, 'usr/bin/scp.exe'))
  assert.equal(selected.keyscan, win32.join(root, 'usr/bin/ssh-keyscan.exe'))
  assert.equal(tools.sshLocalPath('D:\\Key Files\\id_ed25519'), '/d/Key Files/id_ed25519')
  assert.equal(tools.probes.length, 0)
})

test('finds Git via registry, common installs, and symlinked PATH entries', () => {
  const root = 'E:\\Portable Git'
  const registryTools = toolsFixture({ registry: { 'HKCU\\Software\\GitForWindows': root }, files: suiteFiles(root) })
  assert.equal(registryTools.getSshTools().ssh, win32.join(root, 'usr/bin/ssh.exe'))
  const calls = registryTools.probes.length
  registryTools.getSshTools()
  assert.equal(registryTools.probes.length, calls)
  const common = toolsFixture({ env: { ProgramFiles: root }, files: suiteFiles(win32.join(root, 'Git')) })
  assert.equal(common.getSshTools().ssh, win32.join(root, 'Git/usr/bin/ssh.exe'))
  const linked = toolsFixture({ env: { PATH: 'C:\\links' }, files: ['C:\\links\\git.exe', ...suiteFiles(root)], realpath: () => win32.join(root, 'bin/git.exe') })
  assert.equal(linked.getSshTools().ssh, win32.join(root, 'usr/bin/ssh.exe'))
})

test('incomplete Git installs fall back as a suite and explicit overrides stay authoritative', () => {
  const root = 'D:\\Git'
  const system = 'C:\\Windows\\System32\\OpenSSH'
  const tools = toolsFixture({ env: { PATH: `${root}\\cmd` }, files: [win32.join(root, 'cmd/git.exe'), win32.join(root, 'usr/bin/ssh.exe'), ...['ssh.exe', 'scp.exe', 'ssh-keyscan.exe'].map((name) => win32.join(system, name))] })
  assert.equal(tools.getSshTools().ssh, win32.join(system, 'ssh.exe'))
  assert.equal(tools.getSshTools().shell, undefined)
  assert.equal(tools.sshLocalPath('D:\\Files\\key'), 'D:\\Files\\key')
  const overridden = toolsFixture({ env: { CLOVER_SSH_BIN: win32.join(system, 'ssh.exe'), CLOVER_SCP_BIN: 'custom-scp', CLOVER_SSH_KEYSCAN_BIN: 'custom-keyscan' }, files: [...suiteFiles(root)] })
  assert.equal(overridden.getSshTools().ssh, win32.join(system, 'ssh.exe'))
  assert.equal(overridden.getSshTools().scp, 'custom-scp')
  assert.equal(overridden.getSshTools().keyscan, 'custom-keyscan')
  assert.equal(overridden.getSshTools().shell, undefined)
  for (const platform of ['darwin', 'linux']) {
    const unix = toolsFixture({ platform, env: { PATH: `${root}\\cmd` }, files: [win32.join(root, 'cmd/git.exe'), ...suiteFiles(root)] })
    assert.deepEqual(unix.getSshTools(), { ssh: 'ssh', scp: 'scp', keyscan: 'ssh-keyscan', shell: undefined })
    assert.equal(unix.sshLocalPath('/Users/fixture/My Keys/id_ed25519'), '/Users/fixture/My Keys/id_ed25519')
    assert.equal(unix.probes.length, 0)
  }
})

test('legacy keys and explicit identity files work for commands, tunnels and SCP', () => fixture(({ ssh }) => {
  for (const args of [ssh.sshArgs(host, 'true'), ssh.sshTunnelArgs(host, 1234, 5678), ssh.scpArgs(host, '/remote', '/local')]) {
    assert(args.includes('BatchMode=yes'))
    assert(args.includes('PreferredAuthentications=publickey'))
    assert(args.includes('StrictHostKeyChecking=yes'))
    assert(args.some((arg) => arg.startsWith('UserKnownHostsFile=') && arg.includes('known_hosts')))
  }
  const args = ssh.sshArgs({ ...host, identityFile: '~/.ssh/key with spaces' }, 'echo "hello"')
  assert(args.includes(join(homedir(), '.ssh/key with spaces')))
  assert(args.includes('IdentitiesOnly=yes'))
  assert.deepEqual(ssh.sshEnv(host), {})
}))

test('unknown hosts require fingerprint confirmation, persist trusted keys, then retry with saved authentication', () => fixture(async ({ root, hosts, state, calls, reloadHosts }) => {
  const data = Buffer.from('fixture public host key').toString('base64')
  state.scan = `# banner ignored\n[127.0.0.1]:2222 ssh-ed25519 ${data}\n`
  state.error = 'No ED25519 host key is known for [127.0.0.1]:2222 and you have requested strict checking.\nHost key verification failed.'
  const saved = hosts.saveTrainingHost({ ...input, authMethod: 'password', password: 'secret' })
  const tested = await hosts.testTrainingHost({}, saved.id)
  assert.equal(tested.status, 'ok')
  assert.equal(tested.authMethod, 'password')
  assert.equal(state.dialogs.length, 1)
  assert(state.dialogs[0].detail.includes(`SHA256:${createHash('sha256').update(Buffer.from(data, 'base64')).digest('base64').replace(/=+$/, '')}`))
  assert.equal(state.dialogs[0].defaultId, 1)
  assert.equal(readFileSync(join(root, 'ssh/known_hosts'), 'utf8').trim(), `[127.0.0.1]:2222 ssh-ed25519 ${data}`)
  assert.equal(calls.filter(([command]) => command === 'ssh').length, 2)
  for (const [, args, options] of calls.filter(([command]) => command === 'ssh')) {
    assert(args.includes('StrictHostKeyChecking=yes'))
    assert(args.includes('PreferredAuthentications=password'))
    assert.equal(options.env.CLOVER_SSH_PASSWORD, 'secret')
  }
  assert.equal(reloadHosts().listTrainingHosts({})[1].authMethod, 'password')
}))

test('cancelled trust, changed keys and failed scans never create a trust record', () => fixture(async ({ root, hostKeys, state }) => {
  const unknown = new Error('No ED25519 host key is known for 127.0.0.1 and you have requested strict checking.')
  state.scan = `127.0.0.1 ssh-ed25519 ${Buffer.from('key').toString('base64')}\n`
  state.response = 1
  assert.equal(await hostKeys.trustUnknownHost(host, unknown), false)
  assert.equal(existsSync(join(root, 'ssh/known_hosts')), false)
  const dialogCount = state.dialogs.length
  assert.equal(await hostKeys.trustUnknownHost(host, new Error('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! Host key verification failed.')), false)
  assert.equal(state.dialogs.length, dialogCount)
  state.scan = ''
  await assert.rejects(hostKeys.trustUnknownHost(host, unknown), /无法读取 SSH 主机密钥/)
  assert.equal(existsSync(join(root, 'ssh/known_hosts')), false)
}))

test('all authentication methods survive reload and edits that omit the method', () => fixture(async ({ hosts, reloadHosts, state }) => {
  for (const authMethod of ['identityFile', 'password', 'none']) {
    const saved = hosts.saveTrainingHost({ ...input, authMethod, password: authMethod === 'password' ? 'secret' : undefined, identityFile: '/fixture/key' })
    assert.equal(reloadHosts().listTrainingHosts({}).find((item) => item.id === saved.id).authMethod, authMethod)
    const edited = hosts.saveTrainingHost({ ...input, id: saved.id, name: 'Renamed' })
    assert.equal(edited.authMethod, authMethod)
    if (authMethod === 'identityFile') assert.equal(edited.identityFile, '/fixture/key')
    state.error = 'Permission denied'
    await hosts.testTrainingHost({}, saved.id)
    assert.equal(reloadHosts().listTrainingHosts({}).find((item) => item.id === saved.id).authMethod, authMethod)
  }
}))

test('password survives reload and blank edits without exposing plaintext in host data or helper', () => fixture(async ({ root, credentials, ssh, hosts, calls, reloadHosts }) => {
  const password = '空 格 \' " $() & % ! 🔑'
  const saved = hosts.saveTrainingHost({ ...input, authMethod: 'password', password })
  assert.equal(saved.hasPassword, true)
  assert.equal(saved.password, undefined)
  assert.equal(readFileSync(join(root, 'hosts.json'), 'utf8').includes(password), false)
  assert.equal(readFileSync(join(root, 'ssh-credentials.json'), 'utf8').includes(password), false)
  assert.equal(credentials.getSshPassword(saved.id), password)
  const reloaded = reloadHosts().listTrainingHosts({})[1]
  assert.equal(reloaded.authMethod, 'password')
  hosts.saveTrainingHost({ ...input, id: saved.id, authMethod: 'password', password: '' })
  assert.equal(credentials.getSshPassword(saved.id), password)
  await ssh.sshExec(saved, 'true')
  await ssh.sshStream(saved, 'true', 1000, () => {})
  await ssh.scpFrom(saved, '/remote', '/local')
  for (const [, args, options] of calls) {
    assert(args.includes('BatchMode=no'))
    assert(args.includes('PreferredAuthentications=password'))
    assert.equal(args.some((arg) => arg.includes(password)), false)
    assert.equal(options.env.CLOVER_SSH_PASSWORD, password)
    assert.equal(options.env.SSH_ASKPASS_REQUIRE, 'force')
  }
  assert.equal(readFileSync(join(root, 'cache/ssh-askpass/askpass.cjs'), 'utf8').includes(password), false)
  assert.equal(process.env.CLOVER_SSH_PASSWORD, undefined)
}))

test('switching methods and deleting hosts clears credentials and stale identity files', () => fixture(({ hosts, credentials, ssh }) => {
  const saved = hosts.saveTrainingHost({ ...input, authMethod: 'password', password: 'secret', identityFile: '/unused' })
  assert.equal(saved.identityFile, undefined)
  const none = hosts.saveTrainingHost({ ...input, id: saved.id, authMethod: 'none' })
  assert.equal(credentials.hasSshPassword(saved.id), false)
  assert.equal(none.hasPassword, false)
  for (const args of [ssh.sshArgs(none, 'true'), ssh.scpArgs(none, '/remote', '/local'), ssh.sshTunnelArgs(none, 1234, 5678)]) {
    assert(args.includes('PreferredAuthentications=none'))
    assert(args.includes('PubkeyAuthentication=no'))
    assert(args.includes('PasswordAuthentication=no'))
    assert.equal(args.includes('-i'), false)
  }
  assert.throws(() => hosts.saveTrainingHost({ ...input, id: saved.id, authMethod: 'password' }), /密码/)
  hosts.saveTrainingHost({ ...input, id: saved.id, authMethod: 'password', password: 'new' })
  hosts.removeTrainingHost(saved.id)
  assert.equal(credentials.hasSshPassword(saved.id), false)
}))

test('unavailable encryption fails without saving host or password', () => fixture(({ root, hosts }) => {
  safeStorage.isEncryptionAvailable = () => false
  try {
    assert.throws(() => hosts.saveTrainingHost({ ...input, authMethod: 'password', password: 'secret' }), /安全存储/)
    assert.equal(hosts.listTrainingHosts({}).length, 1)
  } finally {
    safeStorage.isEncryptionAvailable = () => true
  }
}))
