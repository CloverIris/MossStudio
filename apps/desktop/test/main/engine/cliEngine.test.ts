import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobParams, JobRecord } from '@shared/types'
import type { CliEngineKind } from '@shared/cliEngine'
import { useTempDataRoot } from '@test/helpers/tempDir'

/**
 * The CLI engine runtime against test/mocks/fakeMossCli.mjs: a real process
 * that speaks the real program's flags, stderr lines and exit codes. spawn is
 * redirected to `node fakeMossCli.mjs <args>` (the installed binary may not be
 * a script on Windows); FAKE_CLI_BEHAVIOR is `<binary>.json` when it exists.
 */
const launches = vi.hoisted(() => [] as Array<{ command: string; args: string[] }>)
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { join: joinPath, basename } = await import('node:path')
  const { existsSync: exists } = await import('node:fs')
  const fake = joinPath(import.meta.dirname, '..', '..', 'mocks', 'fakeMossCli.mjs')
  const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
    launches.push({ command, args })
    const behavior = `${command}.json`
    return actual.spawn(process.execPath, [fake, ...args], {
      ...options,
      env: {
        ...process.env,
        FAKE_CLI_KIND: basename(command).includes('hip') ? 'hip' : 'vulkan',
        ...(exists(behavior) ? { FAKE_CLI_BEHAVIOR: behavior } : {}),
      },
    })
  }) as typeof actual.spawn
  const execFile = ((command: string, args: string[], options: Record<string, unknown>, callback: (...result: unknown[]) => void) => {
    launches.push({ command, args })
    const behavior = `${command}.json`
    return actual.execFile(process.execPath, [fake, ...args], {
      ...options,
      env: {
        ...process.env,
        FAKE_CLI_KIND: basename(command).includes('hip') ? 'hip' : 'vulkan',
        ...(exists(behavior) ? { FAKE_CLI_BEHAVIOR: behavior } : {}),
      },
    }, callback)
  }) as unknown as typeof actual.execFile
  return { ...actual, spawn, execFile, default: { ...actual, spawn, execFile } }
})

const dataRoot = useTempDataRoot()
let cli: typeof import('@main/services/cliEngine')

const params: JobParams = { prompt: 'a red apple', negativePrompt: 'blurry', width: 64, height: 48, steps: 4, cfg: 3, seed: 7, profile: 'base' }

interface Behavior {
  stepMs?: number
  failAt?: 'start' | 'text' | 'denoise' | 'vae'
  failMessage?: string
  failCode?: number
  noPng?: boolean
  ignoreTerm?: boolean
  pidFile?: string
  warning?: string
  listFail?: string
  devices?: unknown[]
}

function binary(kind: CliEngineKind, behavior?: Behavior): string {
  const dir = join(dataRoot(), 'engines', kind, 'bin')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `moss-infer-${kind}${process.platform === 'win32' ? '.exe' : ''}`)
  writeFileSync(path, '')
  if (behavior) writeFileSync(`${path}.json`, JSON.stringify(behavior))
  return path
}

function bundle(): string {
  const root = join(dataRoot(), 'bundle')
  for (const dir of ['tokenizer', 'transformer', 'text_encoder', 'vae']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'tokenizer', 'tokenizer.json'), '{}')
  return root
}

interface Run {
  events: Array<Record<string, unknown>>
  stderr: string[]
  done: Promise<number>
  output: string
}

function run(id: string, options: { kind?: CliEngineKind; behavior?: Behavior; params?: Partial<JobParams>; deviceUuid?: string; cliDeviceIndex?: number; model?: string; expectedDevice?: { name: string; gfxTarget?: string } } = {}): Run {
  const kind = options.kind ?? 'vulkan'
  const events: Array<Record<string, unknown>> = []
  const stderr: string[] = []
  let resolveDone: (code: number) => void = () => undefined
  const done = new Promise<number>((resolve) => { resolveDone = resolve })
  const output = join(dataRoot(), 'outputs', `${id}-1.png`)
  void cli.runCliJob({ id } as JobRecord, { ...params, ...options.params }, {
    kind,
    binary: binary(kind, options.behavior),
    version: '2.2.0',
    model: options.model ?? bundle(),
    output,
    deviceUuid: options.deviceUuid ?? 'vk-1002-744c-0',
    cliDeviceIndex: options.cliDeviceIndex,
    ...(options.expectedDevice ? { expectedDevice: options.expectedDevice } : {}),
  }, { event: (payload) => events.push(payload), stderr: (line) => stderr.push(line), done: resolveDone })
  return { events, stderr, done, output }
}

const types = (r: Run): string[] => r.events.map((event) => String(event['type']))
const errorOf = (r: Run): Record<string, unknown> | undefined => r.events.find((event) => event['type'] === 'error')

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeEach(async () => {
  vi.resetModules()
  launches.length = 0
  cli = await import('@main/services/cliEngine')
})
afterEach(async () => {
  await cli.shutdownCliEngines()
})

describe('runCliJob', () => {
  it('runs one text-to-image job and turns the real stderr lines into runner events', async () => {
    const r = run('job-1', { cliDeviceIndex: 0 })
    expect(await r.done).toBe(0)
    expect(launches[0]!.args).toEqual([
      '--model', join(dataRoot(), 'bundle'), '--prompt', 'a red apple', '--negative', 'blurry',
      '--width', '64', '--height', '48', '--steps', '4', '--cfg', '3', '--seed', '7', '--device', '0', '-o', r.output,
    ])
    expect(r.events.slice(0, 3)).toEqual([
      { type: 'hello', protocol: 1, runner_version: 'moss-infer-vulkan-2.2.0' },
      { type: 'ready', device: 'vulkan:0', dtype: 'bf16', capabilities: ['progress', 'cancel'] },
      { type: 'stage', name: 'load' },
    ])
    expect(r.events.slice(3, 10)).toEqual([
      { type: 'stage', name: 'text' },
      { type: 'stage', name: 'denoise' },
      { type: 'progress', stage: 'denoise', current: 0, total: 4, percent: 0 },
      { type: 'progress', stage: 'denoise', current: 1, total: 4, percent: 25, eta_ms: 30 },
      { type: 'progress', stage: 'denoise', current: 2, total: 4, percent: 50, eta_ms: 20 },
      { type: 'progress', stage: 'denoise', current: 3, total: 4, percent: 75, eta_ms: 10 },
      { type: 'progress', stage: 'denoise', current: 4, total: 4, percent: 100, eta_ms: 0 },
    ])
    expect(r.events[10]).toEqual({ type: 'stage', name: 'decode' })
    expect(r.events[11]).toEqual({ type: 'stage', name: 'save' })
    expect(r.events[12]).toMatchObject({
      type: 'result',
      images: [{ path: r.output, width: 64, height: 48, seed: 7 }],
      timings: { load_ms: 1200, text_encode_ms: 400, denoise_ms: 0, decode_ms: 300 },
    })
    expect(r.events).toHaveLength(13)
    // The engine's own lines go to the job log as they are.
    expect(r.stderr[0]).toBe('vulkan: device 0, NVIDIA GeForce RTX 4090 Laptop GPU; kernels: coop')
    expect(r.stderr.at(-1)).toMatch(/^done: seed 7; text encoder 0\.4 s, DiT load 1\.2 s \(42 of 42 blocks on the device\)/)
    expect(readFileSync(r.output).subarray(1, 4).toString()).toBe('PNG')
    expect(JSON.parse(readFileSync(r.output.replace(/\.png$/, '.json'), 'utf8'))).toEqual({
      prompt: 'a red apple', negative_prompt: 'blurry', seed: 7, width: 64, height: 48, engine: 'mossinfer', backend: 'vulkan', tier: 'reference',
    })
  })

  it('takes the seed the program reports for a random seed, and runs moss-infer-hip the same way', async () => {
    const r = run('job-hip', { kind: 'hip', params: { seed: -1, sampling: { shift: 4 } } })
    expect(await r.done).toBe(0)
    expect(launches[0]!.args).toContain('--shift')
    expect(launches[0]!.args).not.toContain('--device')
    expect(r.events[0]).toEqual({ type: 'hello', protocol: 1, runner_version: 'moss-infer-hip-2.2.0' })
    expect(r.stderr[0]).toBe('hip: device 0, AMD Radeon RX 7900 XTX (gfx1100); kernels: gfx1100, wmma')
    const done = r.stderr.find((line) => line.startsWith('done: seed '))!
    const seed = Number(/^done: seed (\d+)/.exec(done)![1])
    const result = r.events.find((event) => event['type'] === 'result') as { images: Array<{ seed: number }> }
    expect(result.images[0]!.seed).toBe(seed)
    expect(JSON.parse(readFileSync(r.output.replace(/\.png$/, '.json'), 'utf8'))).toMatchObject({ seed, backend: 'hip' })
  })

  it('passes a prompt warning on as a job log warning', async () => {
    const warning = 'prompt truncated to 4096 of 4200 tokens (104 dropped; --max-seq 4096)'
    const r = run('job-warn', { behavior: { warning } })
    expect(await r.done).toBe(0)
    expect(r.events).toContainEqual({ type: 'log', level: 'warn', message: warning })
  })

  it('refuses inputs the CLI cannot do before starting anything', async () => {
    const r = run('job-lora', { params: { adapters: [{ path: '/l.safetensors', strength: 1 }], initImage: { path: '/i.png', strength: 0.5 } } })
    expect(await r.done).toBe(1)
    expect(errorOf(r)).toEqual({ type: 'error', code: 'E_NOT_SUPPORTED', message: '兼容模式引擎只能文生图，不支持LoRA、起始图，请移除后再生成', fatal: true })
    expect(launches).toHaveLength(0)
  })

  it('needs a bundle folder: scanned single files and incomplete bundles are refused with the reason', async () => {
    const files = run('job-files', { model: '' })
    expect(await files.done).toBe(1)
    expect(errorOf(files)).toMatchObject({ code: 'E_MODEL', message: expect.stringContaining('扫描到的单个模型文件用不了') })
    const partial = join(dataRoot(), 'partial')
    mkdirSync(join(partial, 'tokenizer'), { recursive: true })
    writeFileSync(join(partial, 'tokenizer', 'tokenizer.json'), '{}')
    const incomplete = run('job-partial', { model: partial })
    expect(await incomplete.done).toBe(1)
    expect(errorOf(incomplete)).toMatchObject({ code: 'E_MODEL', message: '模型包缺少 transformer，请在模型库重新下载' })
    expect(launches).toHaveLength(0)
  })

  it('says when the program is not installed', async () => {
    const events: Array<Record<string, unknown>> = []
    let code = -99
    await cli.runCliJob({ id: 'job-missing' } as JobRecord, params, {
      kind: 'vulkan', binary: join(dataRoot(), 'nowhere', 'moss-infer-vulkan'), model: bundle(), output: join(dataRoot(), 'o.png'), deviceUuid: 'vk-a',
    }, { event: (payload) => events.push(payload), stderr: () => undefined, done: (exit) => { code = exit } })
    expect(code).toBe(1)
    expect(events).toEqual([{ type: 'error', code: 'E_ENGINE', message: '找不到 moss-infer-vulkan，请到 设置 › 设备 重新安装引擎', fatal: true }])
  })
})

describe('runCliJob: failures', () => {
  it('exit 2 (a request the program does not take) is E_NOT_SUPPORTED with its message, not the usage text', async () => {
    const r = run('job-size', { params: { width: 100 } })
    expect(await r.done).toBe(2)
    expect(errorOf(r)).toEqual({
      type: 'error', code: 'E_NOT_SUPPORTED', message: '引擎不接受这次的设置：宽和高必须是 16 的倍数（Height and width must be positive multiples of 16.）', fatal: true,
    })
    expect(r.stderr.some((line) => line.startsWith('usage: moss-infer-vulkan'))).toBe(true)
  })

  it('a run the device cannot hold is E_OOM', async () => {
    const r = run('job-oom', { behavior: { failAt: 'start', failMessage: 'the DiT at 2048x2048 needs at least 9000 MiB of device memory (its activations, every block streamed); 4000 MiB are free' } })
    expect(await r.done).toBe(1)
    expect(errorOf(r)).toMatchObject({ code: 'E_OOM', message: expect.stringContaining('9000 MiB of device memory') })
  })

  it('a device index the program does not have is E_DEVICE', async () => {
    const r = run('job-device', { cliDeviceIndex: 3 })
    expect(await r.done).toBe(1)
    expect(errorOf(r)).toMatchObject({ code: 'E_DEVICE', message: '引擎用不了这张显卡：no Vulkan device 3: there are 1' })
  })

  it('a failure mid-denoise keeps the progress so far and fails the job', async () => {
    const r = run('job-lost', { behavior: { failAt: 'denoise', failMessage: 'vkQueueSubmit: VK_ERROR_DEVICE_LOST' } })
    expect(await r.done).toBe(1)
    expect(r.events.filter((event) => event['type'] === 'progress').length).toBeGreaterThan(1)
    expect(errorOf(r)).toMatchObject({ code: 'E_ENGINE', message: '生成失败：vkQueueSubmit: VK_ERROR_DEVICE_LOST' })
    expect(existsSync(r.output)).toBe(false)
  })

  it('exit 0 without a picture is E_NO_RESULT', async () => {
    const r = run('job-nopng', { behavior: { noPng: true } })
    expect(await r.done).toBe(1)
    expect(errorOf(r)).toMatchObject({ code: 'E_NO_RESULT' })
  })
})

describe('runCliJob: queue and cancel', () => {
  it('runs jobs on one device one after another, in order, and other devices at the same time', async () => {
    const a = run('job-a', { behavior: { stepMs: 40 }, deviceUuid: 'vk-a' })
    const b = run('job-b', { behavior: { stepMs: 40 }, deviceUuid: 'vk-a' })
    const c = run('job-c', { behavior: { stepMs: 40 }, deviceUuid: 'vk-b' })
    await until(() => launches.length === 2)
    // job-b waits for job-a; job-c's device is free.
    expect(b.events[0]).toEqual({ type: 'log', level: 'info', message: 'moss-infer-vulkan 正在运行上一个任务，排队等待' })
    expect(launches.map((launch) => launch.args.at(-1))).toEqual([a.output, c.output])
    expect(await a.done).toBe(0)
    expect(await b.done).toBe(0)
    expect(await c.done).toBe(0)
    expect(launches.map((launch) => launch.args.at(-1))).toEqual([a.output, c.output, b.output])
    expect(cli.cliEngineBusy()).toBe(false)
  })

  it('cancel terminates the running program; the job ends canceled at its stage and the next one starts', async () => {
    const a = run('job-a', { behavior: { stepMs: 200 }, deviceUuid: 'vk-a' })
    const b = run('job-b', { deviceUuid: 'vk-a' })
    await until(() => a.events.some((event) => event['type'] === 'progress' && event['current'] === 1))
    expect(cli.cliEngineBusy('vk-a')).toBe(true)
    expect(cli.cancelCliJob('job-a')).toBe(true)
    expect(await a.done).toBe(130)
    expect(a.events.at(-1)).toEqual({ type: 'canceled', at_stage: 'denoise' })
    expect(types(a)).not.toContain('error')
    expect(await b.done).toBe(0)
  })

  it('a program that ignores the terminate request is killed after the grace period', async () => {
    const pidFile = join(dataRoot(), 'pid')
    const r = run('job-stuck', { behavior: { stepMs: 1000, ignoreTerm: true, pidFile } })
    await until(() => r.events.some((event) => event['type'] === 'stage' && event['name'] === 'denoise'))
    const started = Date.now()
    cli.cancelCliJob('job-stuck')
    expect(await r.done).toBe(130)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
    // On POSIX SIGTERM is ignored and SIGKILL ends it after the grace; on Windows the first kill ends it.
    if (process.platform !== 'win32') expect(Date.now() - started).toBeGreaterThanOrEqual(cli.CLI_CANCEL_GRACE_MS - 100)
  }, 15_000)

  it('cancel of a waiting job removes it without starting it', async () => {
    const a = run('job-a', { behavior: { stepMs: 100 }, deviceUuid: 'vk-a' })
    const b = run('job-b', { deviceUuid: 'vk-a' })
    await until(() => launches.length === 1)
    expect(cli.cancelCliJob('job-b')).toBe(true)
    expect(await b.done).toBe(130)
    expect(b.events.at(-1)).toEqual({ type: 'canceled', at_stage: 'idle' })
    expect(cli.cancelCliJob('job-unknown')).toBe(false)
    cli.cancelCliJob('job-a')
    await a.done
    expect(launches).toHaveLength(1)
  })

  it('shutdown stops every running and waiting job and resolves once the programs exited', async () => {
    const pidFile = join(dataRoot(), 'pid')
    const a = run('job-a', { behavior: { stepMs: 500, pidFile }, deviceUuid: 'vk-a' })
    const b = run('job-b', { deviceUuid: 'vk-a' })
    await until(() => existsSync(pidFile) && a.events.some((event) => event['type'] === 'ready'))
    await cli.shutdownCliEngines()
    expect(await a.done).toBe(130)
    expect(await b.done).toBe(130)
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow()
    expect(cli.cliEngineBusy()).toBe(false)
  })
})

describe('hipDeviceIndex', () => {
  const devices = [
    { name: 'AMD Radeon RX 6800', arch: 'gfx1030', gib: 16, unusable: "this build's kernels are for gfx1100, the device is gfx1030" },
    { name: 'AMD Radeon RX 7900 XTX', arch: 'gfx1100', gib: 24, kernels: 'gfx1100, wmma' },
    { name: 'AMD Radeon RX 7900 XTX', arch: 'gfx1100', gib: 24, kernels: 'gfx1100, wmma' },
  ]
  const lists = () => launches.filter((launch) => launch.args[0] === '--list-devices').length

  it("reads moss-infer-hip's own device order once per binary and environment, and picks the card of our GPU", async () => {
    const hip = binary('hip', { devices })
    expect(await cli.hipDeviceIndex(hip, { gfxTarget: 'gfx1100' }, 0)).toEqual({ ok: true, index: 1 })
    expect(await cli.hipDeviceIndex(hip, { gfxTarget: 'gfx1100' }, 1)).toEqual({ ok: true, index: 2 })
    expect(lists()).toBe(1)
    // Another LD_LIBRARY_PATH can load another ROCm: asked again.
    expect(await cli.hipDeviceIndex(hip, { gfxTarget: 'gfx1100' }, 0, { LD_LIBRARY_PATH: '/opt/rocm-7.1/lib' })).toEqual({ ok: true, index: 1 })
    expect(lists()).toBe(2)
    expect(await cli.hipDeviceIndex(hip, {}, 0)).toEqual({ ok: true })
  })

  it('never puts a card the list does not have onto another one', async () => {
    const hip = binary('hip', { devices })
    expect(await cli.hipDeviceIndex(hip, { name: 'AMD Radeon RX 7900 XTX', gfxTarget: 'gfx1100' }, 2)).toEqual({
      ok: false, message: 'moss-infer-hip 没有找到这张显卡（「AMD Radeon RX 7900 XTX」，gfx1100，同型号第 3 张），请到 设置 › 设备 重新检测显卡后再试',
    })
    expect(await cli.hipDeviceIndex(hip, { gfxTarget: 'gfx1030' }, 0)).toMatchObject({ ok: false })
  })

  it('a failed list is an error with the program’s message and is not remembered', async () => {
    const hip = binary('hip', { listFail: 'hip: hipGetDeviceCount: no ROCm-capable device is detected' })
    expect(await cli.hipDeviceIndex(hip, { gfxTarget: 'gfx1100' }, 0)).toEqual({
      ok: false, message: '无法读取 moss-infer-hip 的显卡列表：moss-infer-hip: hip: hipGetDeviceCount: no ROCm-capable device is detected',
    })
    writeFileSync(`${hip}.json`, JSON.stringify({ devices }))
    expect(await cli.hipDeviceIndex(hip, { gfxTarget: 'gfx1100' }, 0)).toEqual({ ok: true, index: 1 })
    expect(lists()).toBe(2)
    expect(await cli.hipDeviceIndex(join(dataRoot(), 'none', 'moss-infer-hip'), { gfxTarget: 'gfx1100' }, 0)).toMatchObject({ ok: false })
  })
})

describe('runCliJob: the device the program chose', () => {
  it('goes on when the program chose the assigned GPU (driver suffixes and vendor marks aside)', async () => {
    const r = run('job-same', { expectedDevice: { name: 'NVIDIA GeForce RTX 4090 Laptop GPU' } })
    expect(await r.done).toBe(0)
  })

  it('stops before anything loads when the program chose another card, and says which', async () => {
    const r = run('job-other', {
      behavior: { stepMs: 300, devices: [{ name: 'Intel(R) UHD Graphics 770', vendor: 0x8086, device: 0xa780, discrete: false, kernels: 'plain' }] },
      expectedDevice: { name: 'Intel(R) Arc(TM) A770 Graphics' },
    })
    expect(await r.done).toBe(1)
    expect(errorOf(r)).toEqual({
      type: 'error', code: 'E_DEVICE', fatal: true,
      message: 'moss-infer-vulkan 选中的是第 0 号显卡「Intel(R) UHD Graphics 770」，不是这个任务分配的「Intel(R) Arc(TM) A770 Graphics」，已在加载模型前停止。请到 设置 › 设备 重新检测显卡后再试',
    })
    expect(r.events.some((event) => event['type'] === 'progress' && Number(event['current']) > 0)).toBe(false)
    expect(existsSync(r.output)).toBe(false)
  })

  it('checks the gfx target moss-infer-hip prints', async () => {
    const r = run('job-gfx', { kind: 'hip', behavior: { stepMs: 300 }, expectedDevice: { name: 'AMD Radeon RX 7900 XTX', gfxTarget: 'gfx1201' } })
    expect(await r.done).toBe(1)
    expect(errorOf(r)).toMatchObject({ code: 'E_DEVICE', message: expect.stringContaining('「AMD Radeon RX 7900 XTX（gfx1100）」') })
  })
})

describe('runCliJob: a cancel that arrives as the program finishes', () => {
  it('a written picture is a success with its sidecar, even when the cancel then stops the program', async () => {
    const events: Array<Record<string, unknown>> = []
    let resolveDone: (code: number) => void = () => undefined
    const done = new Promise<number>((resolve) => { resolveDone = resolve })
    const output = join(dataRoot(), 'outputs', 'job-late-1.png')
    await cli.runCliJob({ id: 'job-late' } as JobRecord, params, {
      kind: 'vulkan', binary: binary('vulkan'), model: bundle(), output, deviceUuid: 'vk-a',
    }, {
      event: (payload) => events.push(payload),
      // The summary line comes after the PNG is written; cancel right there, before the program exits.
      stderr: (line) => { if (line.startsWith('done: ')) cli.cancelCliJob('job-late') },
      done: resolveDone,
    })
    expect(await done).toBe(0)
    expect(events.map((event) => event['type'])).toContain('result')
    expect(events.map((event) => event['type'])).not.toContain('canceled')
    expect(existsSync(output.replace(/\.png$/, '.json'))).toBe(true)
  })

  it('without the summary line a cancel stays a cancel', async () => {
    const r = run('job-early', { behavior: { stepMs: 200 } })
    await until(() => r.events.some((event) => event['type'] === 'progress' && event['current'] === 1))
    cli.cancelCliJob('job-early')
    expect(await r.done).toBe(130)
    expect(types(r)).not.toContain('result')
  })
})

describe('shutdownCliEngines with a filter', () => {
  it('stops only the jobs of the package being replaced', async () => {
    const vulkan = run('job-vk', { behavior: { stepMs: 300 }, deviceUuid: 'vk-a' })
    const hip = run('job-hip', { kind: 'hip', behavior: { stepMs: 300 }, deviceUuid: 'vk-b' })
    const hipWaiting = run('job-hip-2', { kind: 'hip', deviceUuid: 'vk-b' })
    await until(() => launches.length === 2)
    await cli.shutdownCliEngines({ kind: 'hip', binary: join(dataRoot(), 'engines', 'hip') })
    expect(await hip.done).toBe(130)
    expect(await hipWaiting.done).toBe(130)
    expect(cli.cliEngineBusy('vk-a')).toBe(true)
    // Another install folder of the same kind is not touched.
    const other = run('job-vk-2', { behavior: { stepMs: 300 }, deviceUuid: 'vk-c' })
    await until(() => launches.length === 3)
    await cli.shutdownCliEngines({ kind: 'vulkan', binary: join(dataRoot(), 'elsewhere') })
    expect(cli.cliEngineBusy('vk-c')).toBe(true)
    cli.cancelCliJob('job-vk')
    cli.cancelCliJob('job-vk-2')
    expect(await vulkan.done).toBe(130)
    expect(await other.done).toBe(130)
  })
})

describe('cliBundleDtypeProblem', () => {
  function safetensors(path: string, dtypes: string[]): void {
    const header = Object.fromEntries(dtypes.map((dtype, index) => [`t${index}`, { dtype, shape: [1], data_offsets: [0, 0] }]))
    const json = Buffer.from(JSON.stringify({ __metadata__: { format: 'pt' }, ...header }))
    const length = Buffer.alloc(8)
    length.writeBigUInt64LE(BigInt(json.length))
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, Buffer.concat([length, json]))
  }
  const folder = (dit: string[], te: string[]): string => {
    const root = join(dataRoot(), `bundle-${dit.join('')}-${te.join('')}`)
    safetensors(join(root, 'transformer', 'diffusion_pytorch_model-00001-of-00003.safetensors'), dit)
    safetensors(join(root, 'text_encoder', 'model-00001-of-00004.safetensors'), te)
    return root
  }

  it('accepts bf16 weights (the real bundle has one F32 tensor in the DiT)', async () => {
    expect(await cli.cliBundleDtypeProblem('vulkan', folder(['F32', 'BF16', 'BF16'], ['BF16']))).toBeNull()
  })

  it('refuses fp16 or quantized weights, naming the part and the engine', async () => {
    expect(await cli.cliBundleDtypeProblem('vulkan', folder(['F16', 'F32'], ['BF16'])))
      .toBe('这个模型的DiT是 F16/F32，兼容模式引擎只能用 bf16 的 MOSS-Image，请换一个模型')
    expect(await cli.cliBundleDtypeProblem('hip', folder(['BF16'], ['I8', 'BF16'])))
      .toBe('这个模型的文本编码器是 I8/BF16，AMD 原生引擎只能用 bf16 的 MOSS-Image，请换一个模型')
  })

  it('refuses what it cannot read', async () => {
    const root = join(dataRoot(), 'broken')
    mkdirSync(join(root, 'transformer'), { recursive: true })
    writeFileSync(join(root, 'transformer', 'a.safetensors'), 'xx')
    expect(await cli.cliBundleDtypeProblem('vulkan', root)).toMatch(/^读不了 transformer\/a\.safetensors：/)
    expect(await cli.cliBundleDtypeProblem('vulkan', join(dataRoot(), 'nothing'))).toBe('模型包缺少 transformer 的权重文件，请在模型库重新下载')
  })
})
