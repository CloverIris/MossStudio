import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JobRecord, Settings, TrainerRunInput, TrainerRuntimeInfo, TrainerVersion } from '@shared/types'
import { run } from '../lib/run'
import { startTrainingJob } from './supervisor'
import { allRemoteVersions, remoteSetup } from './remoteTrainer'
import { getTrainingHost } from './trainingHosts'
import { checkBareMirror } from './gitHealth'
import { posixQuote, sshArgs, sshCommand, sshEnv, sshExec } from './ssh'
import { hasUv, parseTrainerDeps, pickPython, venvPython } from './trainerEnv'
import {
  createTrainerWorktree,
  ensureTrainerMirror,
  isTrainerDirty,
  listTrainerCommits,
  removeTrainerWorktree,
  trainerCommitExists,
  trainerMirror,
  trainerRuntimeDir,
  trainerTagSha,
  trainerVersionDir,
  trainerVersionsDir,
} from './trainerGit'

function versionFile(settings: Settings, id: string): string {
  return join(trainerVersionDir(settings, id), 'trainer.json')
}

function runtimeDir(settings: Settings, id: string): string {
  return trainerRuntimeDir(settings, id)
}

function runtimeFile(settings: Settings, id: string): string {
  return join(runtimeDir(settings, id), 'runtime.json')
}

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8)
}

async function readRuntime(settings: Settings, id: string): Promise<TrainerRuntimeInfo | null> {
  try {
    return JSON.parse(await readFile(runtimeFile(settings, id), 'utf8')) as TrainerRuntimeInfo
  } catch {
    return null
  }
}

async function writeRuntime(settings: Settings, runtime: TrainerRuntimeInfo): Promise<void> {
  await mkdir(runtimeDir(settings, runtime.id), { recursive: true })
  await writeFile(runtimeFile(settings, runtime.id), JSON.stringify(runtime, null, 2), 'utf8')
}

async function readVersion(settings: Settings, id: string): Promise<TrainerVersion | null> {
  try {
    const raw = JSON.parse(await readFile(versionFile(settings, id), 'utf8')) as TrainerVersion
    if (!raw.hostId) {
      raw.hostId = 'local'
      raw.hostName = '本机'
    }
    return raw
  } catch {
    return null
  }
}

async function writeVersion(settings: Settings, version: TrainerVersion): Promise<void> {
  await mkdir(version.path, { recursive: true })
  await writeFile(versionFile(settings, version.id), JSON.stringify(version, null, 2), 'utf8')
}

async function syncVersion(settings: Settings, version: TrainerVersion): Promise<TrainerVersion> {
  if (!existsSync(version.path)) {
    version.status = 'missing'
    return version
  }
  version.dirty = await isTrainerDirty(version.path)
  version.status = 'ok'
  if (version.runtimeId) {
    const runtime = await readRuntime(settings, version.runtimeId)
    version.runtimeState = runtime?.state ?? 'missing'
  }
  return version
}

export async function listAllTrainerVersions(settings: Settings): Promise<TrainerVersion[]> {
  const local = await listTrainerVersions(settings)
  return [...local, ...allRemoteVersions(settings)]
}

export async function findTrainerVersion(settings: Settings, id: string): Promise<TrainerVersion | null> {
  const local = await listTrainerVersions(settings)
  return local.find((item) => item.id === id) ?? allRemoteVersions(settings).find((item) => item.id === id) ?? null
}

export async function listTrainerVersions(settings: Settings): Promise<TrainerVersion[]> {
  const dir = trainerVersionsDir(settings)
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const out: TrainerVersion[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const version = await readVersion(settings, entry.name)
      if (version) out.push(await syncVersion(settings, version))
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  } catch {
    return []
  }
}

export interface CreateTrainerVersionInput {
  branch: string
  commit: string
  name?: string
}

export async function createTrainerVersion(settings: Settings, input: CreateTrainerVersionInput): Promise<TrainerVersion> {
  await ensureTrainerMirror(settings)
  if (!(await trainerCommitExists(settings, input.commit))) throw new Error('训练器提交不存在，请先拉取仓库')
  const commits = await listTrainerCommits(settings, input.branch, 200)
  const commit = commits.find((item) => item.sha === input.commit)
  const id = `kohaku-${input.commit.slice(0, 7)}`
  const existing = await readVersion(settings, id)
  if (existing) return syncVersion(settings, existing)
  const path = trainerVersionDir(settings, id)
  await createTrainerWorktree(settings, input.commit, path)
  const stableSha = await trainerTagSha(settings)
  const version: TrainerVersion = {
    id,
    hostId: 'local',
    hostName: '本机',
    name: input.name?.trim() || `Kohaku ${input.commit.slice(0, 7)}`,
    branch: input.branch,
    commit: input.commit,
    shortCommit: commit?.short ?? input.commit.slice(0, 7),
    commitDate: commit?.date ?? new Date().toISOString(),
    subject: commit?.subject ?? '',
    author: commit?.author ?? '',
    channel: stableSha === input.commit ? 'stable' : 'experimental',
    path,
    runtimeId: '',
    runtimeState: 'missing',
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    dirty: false,
    status: 'ok',
  }
  await writeVersion(settings, version)
  return version
}

export async function removeTrainerVersion(settings: Settings, id: string): Promise<void> {
  const version = await readVersion(settings, id)
  if (!version) return
  const others = (await listTrainerVersions(settings)).filter((item) => item.id !== id)
  await removeTrainerWorktree(settings, version.path)
  await rm(trainerVersionDir(settings, id), { recursive: true, force: true })
  if (version.runtimeId && !others.some((item) => item.runtimeId === version.runtimeId)) {
    await rm(runtimeDir(settings, version.runtimeId), { recursive: true, force: true })
  }
}

export async function ensureTrainerRuntime(settings: Settings, versionId: string): Promise<TrainerRuntimeInfo> {
  const version = await readVersion(settings, versionId)
  if (!version) throw new Error('训练版本不存在')
  if (!existsSync(version.path)) throw new Error('训练版本目录不存在')
  if (version.runtimeId) {
    const existing = await readRuntime(settings, version.runtimeId)
    if (existing && existsSync(venvPython(existing.path))) return existing
  }
  const deps = parseTrainerDeps(version.path)
  const python = await pickPython(settings)
  const lockHash = hash(JSON.stringify({ python: python.version, platform: process.platform, arch: process.arch, deps: [...deps].sort() }))
  const runtimeId = `tr-py${python.version.replace(/\./g, '')}-${lockHash}`
  const existing = await readRuntime(settings, runtimeId)
  if (existing) {
    version.runtimeId = runtimeId
    version.runtimeState = existing.state
    await writeVersion(settings, version)
    return existing
  }
  const target = runtimeDir(settings, runtimeId)
  await mkdir(target, { recursive: true })
  const uv = await hasUv()
  const result = uv
    ? await run('uv', ['venv', target, '--python', python.path], { timeoutMs: 180_000 })
    : await run(python.path, ['-m', 'venv', target], { timeoutMs: 180_000 })
  if (result.code !== 0) throw new Error(`创建训练环境失败：${result.stderr.slice(-500)}`)
  const runtime: TrainerRuntimeInfo = {
    id: runtimeId,
    versionId,
    path: target,
    python: venvPython(target),
    pythonVersion: python.version,
    lockHash,
    state: 'created',
    deps,
    createdAt: new Date().toISOString(),
  }
  await writeRuntime(settings, runtime)
  version.runtimeId = runtimeId
  version.runtimeState = 'created'
  await writeVersion(settings, version)
  return runtime
}

export async function installTrainerRuntime(settings: Settings, versionId: string): Promise<TrainerRuntimeInfo> {
  const version = await readVersion(settings, versionId)
  if (!version) throw new Error('训练版本不存在')
  const runtime = await ensureTrainerRuntime(settings, versionId)
  runtime.state = 'installing'
  await writeRuntime(settings, runtime)
  version.runtimeState = 'installing'
  await writeVersion(settings, version)
  const python = runtime.python
  const index = settings.pipIndex ?? 'https://pypi.org/simple'
  const uv = await hasUv()
  const result = uv
    ? await run('uv', ['pip', 'install', '--python', python, '--index-url', index, '-e', version.path], {
        timeoutMs: 3_600_000,
      })
    : await run(python, ['-m', 'pip', 'install', '--index-url', index, '-e', version.path], {
        timeoutMs: 3_600_000,
      })
  runtime.state = result.code === 0 ? 'ready' : 'error'
  await writeRuntime(settings, runtime)
  version.runtimeState = runtime.state
  await writeVersion(settings, version)
  if (result.code !== 0) throw new Error(`训练依赖安装失败：${result.stderr.slice(-1200)}`)
  return runtime
}

export async function trainerDoctor(settings: Settings, versionId: string): Promise<{ ok: boolean; output: string }> {
  const version = await readVersion(settings, versionId)
  if (!version) throw new Error('训练版本不存在')
  const runtime = version.runtimeId ? await readRuntime(settings, version.runtimeId) : null
  if (!runtime || !existsSync(runtime.python)) {
    throw new Error('训练环境尚未创建，请先安装环境')
  }
  const bin =
    process.platform === 'win32' ? join(runtime.path, 'Scripts', 'kohakumoss-doctor.exe') : join(runtime.path, 'bin', 'kohakumoss-doctor')
  const command = existsSync(bin) ? bin : runtime.python
  const args = existsSync(bin) ? [] : ['-m', 'kohakumoss.cli.doctor']
  const result = await run(command, args, { cwd: version.path, timeoutMs: 120_000 })
  const output = `${result.stdout}${result.stderr}`.trim()
  return { ok: result.code === 0, output: output.slice(-12000) }
}

export async function trainerMirrorInfo(settings: Settings): Promise<{ ready: boolean; path: string }> {
  const mirror = trainerMirror(settings)
  const health = await checkBareMirror(mirror)
  return { ready: health.healthy, path: mirror }
}

export async function trainerRuntimeSummary(settings: Settings, versionId: string): Promise<TrainerRuntimeInfo | null> {
  const version = await readVersion(settings, versionId)
  if (!version?.runtimeId) return null
  return readRuntime(settings, version.runtimeId)
}

function quote(value: string): string {
  return process.platform === 'win32' ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, `'\\''`)}'`
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export async function startTrainerRun(settings: Settings, input: TrainerRunInput): Promise<JobRecord> {
  const version = await findTrainerVersion(settings, input.versionId)
  if (!version) throw new Error('训练版本不存在')
  if (version.hostId !== 'local') return startRemoteTrainerRun(settings, input, version)
  if (process.platform === 'darwin') {
    throw new Error('KohakuMossTrainer 不支持 macOS/MPS；请使用 Linux/Windows + NVIDIA，或下一阶段的 SSH 训练主机')
  }
  const cuda = await run('nvidia-smi', ['-L'], { timeoutMs: 8000 })
  if (cuda.code !== 0) throw new Error('未检测到 NVIDIA CUDA 设备，KohakuMossTrainer 无法在本机启动')
  const runtime = version.runtimeId ? await readRuntime(settings, version.runtimeId) : null
  if (!runtime || runtime.state !== 'ready' || !existsSync(runtime.python)) {
    throw new Error('训练环境尚未就绪，请先在训练页安装环境')
  }
  if (input.action === 'export' || input.action === 'sample') {
    const runName = input.runName.replace(/[^A-Za-z0-9_-]/g, '-') || 'moss-lora'
    const exportPath = `exports/${runName}.safetensors`
    const sampleDir = `samples/${runName}`
    if (process.platform === 'win32') {
      const script = join(version.path, `.clover-${input.action}.ps1`)
      const lines = [
        "$ErrorActionPreference = 'Stop'",
        `Set-Location -LiteralPath ${powershellLiteral(version.path)}`,
        `$runName = ${powershellLiteral(runName)}`,
        `$weights = ${powershellLiteral(input.weights)}`,
        `$exportPath = ${powershellLiteral(exportPath)}`,
        `$sampleDir = ${powershellLiteral(sampleDir)}`,
        `$checkpointRoot = Join-Path (Join-Path 'runs/moss' $runName) 'checkpoints'`,
        "$adapter = Get-ChildItem -LiteralPath $checkpointRoot -Filter 'trainable.safetensors' -File -Recurse -ErrorAction SilentlyContinue | Sort-Object { $match = [regex]::Match($_.FullName, '(?i)(?:step|checkpoint)[-_]?(\\d+)'); if ($match.Success) { [long]$match.Groups[1].Value } else { 0 } } | Select-Object -Last 1",
        "if (-not $adapter) { throw '没有找到可导出的训练 checkpoint' }",
        `$kogine = Join-Path ${powershellLiteral(join(runtime.path, 'Scripts'))} 'kogine.exe'`,
        ...(input.action === 'export'
          ? [
              'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $exportPath) | Out-Null',
              '& $kogine run scripts/export/export.py --set "WEIGHTS=$weights" --set "ADAPTER=$($adapter.FullName)" --set "OUT=$exportPath"',
            ]
          : [
              '$exportedAdapter = Join-Path (Get-Location) $exportPath',
              "if (-not (Test-Path -LiteralPath $exportedAdapter)) { throw '请先导出 adapter，再执行采样' }",
              'New-Item -ItemType Directory -Force -Path $sampleDir | Out-Null',
              '& $kogine run scripts/sample/sample.py --set "WEIGHTS=$weights" --set "ADAPTERS=${exportPath}:1.0" --set "PROMPT=a lighthouse on a rocky coast at sunset" --set "OUT=$sampleDir"',
            ]),
        'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        'exit 0',
      ]
      await writeFile(script, `${lines.join('\r\n')}\r\n`, 'utf8')
      return startTrainingJob({
        versionId: version.id,
        name: `Kohaku ${input.action === 'export' ? '导出' : '采样'}`,
        cwd: version.path,
        command: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        totalSteps: 0,
        runName,
        action: input.action,
        weights: input.weights,
        algo: input.algo,
      })
    }
    const find = `ADAPTER="$(find "runs/moss/${runName}/checkpoints" -name trainable.safetensors -print 2>/dev/null | sort -V | tail -1)"`
    const guard = 'test -n "$ADAPTER"'
    const exportCommand = [
      `mkdir -p exports`,
      find,
      guard,
      `${quote(join(runtime.path, 'bin', 'kogine'))} run scripts/export/export.py --set WEIGHTS=${quote(input.weights)} --set ADAPTER="$ADAPTER" --set OUT=${quote(exportPath)}`,
    ].join('\n')
    const sampleCommand = [
      'mkdir -p samples',
      find,
      guard,
      `mkdir -p ${quote(sampleDir)}`,
      `${quote(join(runtime.path, 'bin', 'kogine'))} run scripts/sample/sample.py --set WEIGHTS=${quote(input.weights)} --set ADAPTERS=${quote(`${exportPath}:1.0`)} --set PROMPT=${quote('a lighthouse on a rocky coast at sunset')} --set OUT=${quote(sampleDir)}`,
    ].join('\n')
    const script = join(version.path, `.clover-${input.action}.sh`)
    await writeFile(script, `#!/usr/bin/env bash\nset -euo pipefail\n${input.action === 'export' ? exportCommand : sampleCommand}\n`, {
      encoding: 'utf8',
      mode: 0o755,
    })
    return startTrainingJob({
      versionId: version.id,
      name: `Kohaku ${input.action === 'export' ? '导出' : '采样'}`,
      cwd: version.path,
      command: 'bash',
      args: [script],
      totalSteps: 0,
      runName,
      action: input.action,
      weights: input.weights,
      algo: input.algo,
    })
  }
  const bin = process.platform === 'win32' ? join(runtime.path, 'Scripts') : join(runtime.path, 'bin')
  const configBin = join(bin, process.platform === 'win32' ? 'kohakumoss-config.exe' : 'kohakumoss-config')
  const kogine = join(bin, process.platform === 'win32' ? 'kogine.exe' : 'kogine')
  if (!existsSync(configBin) || !existsSync(kogine)) throw new Error('训练环境缺少 kohakumoss-config / kogine，请重装环境')

  const runName = input.runName.replace(/[^A-Za-z0-9_-]/g, '-')
  const configPath = `configs/user/${runName}.py`
  const dataConfigPath = `configs/user/${runName}_data.py`
  const overrides = input.overrides
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .flatMap((line) => ['--set', line])

  const setup = [
    quote(configBin),
    'new',
    'train',
    '--weights',
    quote(input.weights),
    '--data',
    quote(input.dataset),
    '--source',
    'kohya',
    '--algo',
    quote(input.algo),
    '--name',
    quote(runName),
    '--steps',
    String(input.steps),
    '--force',
  ].join(' ')

  const setArgs = [
    `--set LR=${input.lr || '1e-4'}`,
    `--set DIM=${input.dim || '32'}`,
    `--set ALPHA=${input.alpha || '32'}`,
    `--set MICROBATCHES=${input.batch || '1'}`,
    `--set TARGET_AREA=${input.resolution * input.resolution}`,
    ...overrides,
  ]
  const runArgs = {
    train: ['run', 'scripts/train/moss.py', '--config', configPath, ...setArgs],
    inspect_data: ['run', 'scripts/data/inspect_data.py', '--config', dataConfigPath],
    cache_text: ['run', 'scripts/data/cache_text.py', '--config', dataConfigPath],
    cache_latents: ['run', 'scripts/data/cache_latents.py', '--config', dataConfigPath],
    export: [],
    sample: [],
  }[input.action]
  if (!runArgs.length) throw new Error('该训练动作尚未接入')

  const win = process.platform === 'win32'
  const lines = win
    ? ['@echo off', 'setlocal', setup, 'if errorlevel 1 exit /b 1', [quote(kogine), ...runArgs.map(quote)].join(' ')]
    : ['#!/usr/bin/env bash', 'set -euo pipefail', setup, [quote(kogine), ...runArgs.map(quote)].join(' ')]
  const script = join(version.path, `.clover-${input.action}.${win ? 'cmd' : 'sh'}`)
  await writeFile(script, `${lines.join(win ? '\r\n' : '\n')}${win ? '\r\n' : '\n'}`, { encoding: 'utf8', mode: 0o755 })
  return startTrainingJob({
    versionId: version.id,
    name: `Kohaku ${input.action === 'train' ? '训练' : input.action}`,
    cwd: version.path,
    command: win ? 'cmd' : 'bash',
    args: win ? ['/d', '/s', '/c', script] : [script],
    totalSteps: input.action === 'train' ? input.steps : 0,
    runName,
    action: input.action,
    weights: input.weights,
    algo: input.algo,
  })
}

async function startRemoteTrainerRun(settings: Settings, input: TrainerRunInput, version: TrainerVersion): Promise<JobRecord> {
  const host = getTrainingHost(settings, version.hostId)
  if (!host || host.kind !== 'ssh') throw new Error('SSH 训练主机不存在')
  if (!version.runtimeId) throw new Error('远端训练环境尚未创建，请先安装环境')
  const cuda = await sshExec(host, 'nvidia-smi -L', 15_000)
  if (cuda.code !== 0) throw new Error(`远端没有可用 NVIDIA CUDA：${(cuda.stderr || cuda.stdout).trim().slice(-600)}`)
  const check = await sshExec(
    host,
    [
      remoteSetup(host),
      `test -x "$RUNTIMES/${version.runtimeId}/bin/kohakumoss-config"`,
      `test -x "$RUNTIMES/${version.runtimeId}/bin/kogine"`,
    ].join('\n'),
    30_000,
  )
  if (check.code !== 0) throw new Error('远端训练环境缺少 kohakumoss-config / kogine，请重装环境')

  const runName = input.runName.replace(/[^A-Za-z0-9_-]/g, '-') || 'moss-lora'
  if (input.action === 'export' || input.action === 'sample') {
    const exportPath = `exports/${runName}.safetensors`
    const sampleDir = `samples/${runName}`
    const script = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      remoteSetup(host),
      `VERSION="$VERSIONS/${version.id}"`,
      `RUNTIME="$RUNTIMES/${version.runtimeId}"`,
      'cd "$VERSION"',
      'echo $$ > "$VERSION/.clover.pid"',
      'trap \'rm -f "$VERSION/.clover.pid"\' EXIT',
      `ADAPTER="$(find "runs/moss/${runName}/checkpoints" -name trainable.safetensors -print 2>/dev/null | sort -V | tail -1)"`,
      'test -n "$ADAPTER"',
      input.action === 'export'
        ? `mkdir -p exports; "$RUNTIME/bin/kogine" run scripts/export/export.py --set WEIGHTS=${posixQuote(input.weights)} --set ADAPTER="$ADAPTER" --set OUT=${posixQuote(exportPath)}`
        : `mkdir -p ${posixQuote(sampleDir)}; "$RUNTIME/bin/kogine" run scripts/sample/sample.py --set WEIGHTS=${posixQuote(input.weights)} --set ADAPTERS=${posixQuote(`${exportPath}:1.0`)} --set PROMPT=${posixQuote('a lighthouse on a rocky coast at sunset')} --set OUT=${posixQuote(sampleDir)}`,
    ].join('\n')
    const marker = `CLOVER_REMOTE_${Date.now()}`
    const write = await sshExec(
      host,
      [
        remoteSetup(host),
        `VERSION="$VERSIONS/${version.id}"`,
        `cat > "$VERSION/.clover-${input.action}.sh" <<'${marker}'`,
        script,
        marker,
        `chmod +x "$VERSION/.clover-${input.action}.sh"`,
      ].join('\n'),
      30_000,
    )
    if (write.code !== 0) throw new Error(`写入远端动作脚本失败：${(write.stderr || write.stdout).trim().slice(-1000)}`)
    return startTrainingJob({
      versionId: version.id,
      hostId: host.id,
      name: `Kohaku ${input.action === 'export' ? '导出' : '采样'} · ${host.name}`,
      cwd: process.cwd(),
      command: sshCommand(),
      env: sshEnv(host),
      args: sshArgs(
        host,
        [remoteSetup(host), `VERSION="$VERSIONS/${version.id}"`, `bash "$VERSION/.clover-${input.action}.sh"`].join('\n'),
      ),
      totalSteps: 0,
      runName,
      action: input.action,
      weights: input.weights,
      algo: input.algo,
      cancelCommand: {
        command: sshCommand(),
        env: sshEnv(host),
        args: sshArgs(
          host,
          [
            remoteSetup(host),
            `VERSION="$VERSIONS/${version.id}"`,
            'if [ -f "$VERSION/.clover.pid" ]; then kill -TERM "$(cat "$VERSION/.clover.pid")" 2>/dev/null || true; fi',
          ].join('\n'),
        ),
      },
    })
  }
  const configPath = `configs/user/${runName}.py`
  const dataConfigPath = `configs/user/${runName}_data.py`
  const overrides = input.overrides
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('=') && !line.startsWith('#'))
  const setupArgs = [
    'new',
    'train',
    '--weights',
    posixQuote(input.weights),
    '--data',
    posixQuote(input.dataset),
    '--source',
    'kohya',
    '--algo',
    posixQuote(input.algo),
    '--name',
    posixQuote(runName),
    '--steps',
    String(input.steps),
    '--force',
  ].join(' ')
  const setArgs = [
    `LR=${input.lr || '1e-4'}`,
    `DIM=${input.dim || '32'}`,
    `ALPHA=${input.alpha || '32'}`,
    `MICROBATCHES=${input.batch || '1'}`,
    `TARGET_AREA=${input.resolution * input.resolution}`,
    ...overrides,
  ].flatMap((item) => ['--set', posixQuote(item)])
  const runArgs = {
    train: ['run', 'scripts/train/moss.py', '--config', posixQuote(configPath), ...setArgs],
    inspect_data: ['run', 'scripts/data/inspect_data.py', '--config', posixQuote(dataConfigPath)],
    cache_text: ['run', 'scripts/data/cache_text.py', '--config', posixQuote(dataConfigPath)],
    cache_latents: ['run', 'scripts/data/cache_latents.py', '--config', posixQuote(dataConfigPath)],
    export: [],
    sample: [],
  }[input.action]
  if (!runArgs.length) throw new Error('该训练动作尚未接入')

  const script = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    remoteSetup(host),
    `VERSION="$VERSIONS/${version.id}"`,
    `RUNTIME="$RUNTIMES/${version.runtimeId}"`,
    'cd "$VERSION"',
    'echo $$ > "$VERSION/.clover.pid"',
    'trap \'rm -f "$VERSION/.clover.pid"\' EXIT',
    `"$RUNTIME/bin/kohakumoss-config" ${setupArgs}`,
    `"$RUNTIME/bin/kogine" ${runArgs.join(' ')}`,
  ].join('\n')
  const marker = `CLOVER_REMOTE_${Date.now()}`
  const write = await sshExec(
    host,
    [
      remoteSetup(host),
      `VERSION="$VERSIONS/${version.id}"`,
      `cat > "$VERSION/.clover-${input.action}.sh" <<'${marker}'`,
      script,
      marker,
      `chmod +x "$VERSION/.clover-${input.action}.sh"`,
    ].join('\n'),
    30_000,
  )
  if (write.code !== 0) throw new Error(`写入远端训练脚本失败：${(write.stderr || write.stdout).trim().slice(-1000)}`)

  const start = [remoteSetup(host), `VERSION="$VERSIONS/${version.id}"`, `bash "$VERSION/.clover-${input.action}.sh"`].join('\n')
  const cancel = [
    remoteSetup(host),
    `VERSION="$VERSIONS/${version.id}"`,
    'if [ -f "$VERSION/.clover.pid" ]; then kill -TERM "$(cat "$VERSION/.clover.pid")" 2>/dev/null || true; fi',
  ].join('\n')
  return startTrainingJob({
    versionId: version.id,
    hostId: host.id,
    name: `Kohaku ${input.action === 'train' ? '训练' : input.action} · ${host.name}`,
    cwd: process.cwd(),
    command: sshCommand(),
    env: sshEnv(host),
    args: sshArgs(host, start),
    totalSteps: input.action === 'train' ? input.steps : 0,
    runName,
    action: input.action,
    cancelCommand: { command: sshCommand(), args: sshArgs(host, cancel), env: sshEnv(host) },
  })
}
