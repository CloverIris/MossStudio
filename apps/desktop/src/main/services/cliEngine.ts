import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { open, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import type { JobParams, JobRecord, JobStage } from '@shared/types'
import type { CliEngineKind } from '@shared/cliEngine'
import { CLI_ENGINE_LABEL } from '@shared/cliEngine'
import {
  CLI_PROGRAM,
  buildCliArgs,
  classifyCliFailure,
  cliUnsupported,
  parseCliLine,
  parseHipDeviceList,
  pickHipIndex,
  sameCliDevice,
  type HipDevice,
} from '../lib/cliProtocol'
import { jobInputsSidecar } from './galleryMeta'
import { outputSizeOf } from './generateParams'
import type { MossInferSink } from './mossInfer'
import { LineSplitter } from './parsers'

/**
 * Runs jobs on the one-shot CLI engines (moss-infer-vulkan, moss-infer-hip):
 * one process per job, one job at a time per device (a FIFO per device, like
 * the moss-server runtimes). The program's stderr becomes the runner events
 * supervisor.handleRunnerEvent already understands; cancel terminates the
 * process and kills it if it is still there after a grace period.
 */

export interface CliJobOptions {
  kind: CliEngineKind
  /** The installed moss-infer-vulkan / moss-infer-hip. */
  binary: string
  /** Package version, for the job log. */
  version?: string
  /** The bundle folder (diffusers layout, bf16 files). */
  model: string
  output: string
  /** Our device; jobs on one device run one after another. */
  deviceUuid: string
  /** The CLI's own index of that device (its `--list-devices`); omitted = its first usable device. */
  cliDeviceIndex?: number
  /** Extra environment, e.g. LD_LIBRARY_PATH for a ROCm 7 outside /opt/rocm/lib. */
  env?: Record<string, string>
  /**
   * The GPU the job was assigned to. The program prints the device it chose
   * before anything loads; a different card stops the job there.
   */
  expectedDevice?: { name: string; gfxTarget?: string }
}

/** How long a terminated program may take to exit before it is killed. */
export const CLI_CANCEL_GRACE_MS = 3000

interface QueuedCliJob {
  job: JobRecord
  params: JobParams
  opts: CliJobOptions
  sink: MossInferSink
}

interface ActiveCliJob extends QueuedCliJob {
  child: ChildProcess
  stage: JobStage
  startedAt: number
  cancelRequested: boolean
  killTimer?: ReturnType<typeof setTimeout>
  /** The program's own error line (`moss-infer-vulkan: …`), the first one. */
  errorMessage: string | null
  done: Extract<ReturnType<typeof parseCliLine>, { kind: 'done' }> | null
  spawnError: Error | null
  /** The program chose another GPU than the job's (its device line), the message to fail with. */
  wrongDevice: string | null
}

interface CliSlot {
  active: ActiveCliJob | null
  queue: QueuedCliJob[]
}

const slots = new Map<string, CliSlot>()

function slotFor(deviceUuid: string): CliSlot {
  let slot = slots.get(deviceUuid)
  if (!slot) {
    slot = { active: null, queue: [] }
    slots.set(deviceUuid, slot)
  }
  return slot
}

function fail(sink: MossInferSink, code: string, message: string, exitCode = 1): void {
  sink.event({ type: 'error', code, message, fatal: true })
  sink.done(exitCode)
}

/** A model folder the CLI can open: it reads these before anything else. */
function bundleProblem(model: string): string | null {
  if (!model) return '这台设备的引擎只能用完整的模型包（bf16），扫描到的单个模型文件用不了，请在模型库下载 MOSS-Image'
  for (const part of ['tokenizer/tokenizer.json', 'transformer', 'text_encoder', 'vae']) {
    if (!existsSync(join(model, part))) return `模型包缺少 ${part}，请在模型库重新下载`
  }
  return null
}

async function writeSidecar(active: ActiveCliJob, seed: number): Promise<void> {
  try {
    const { params, opts } = active
    const size = outputSizeOf(params)
    await writeFile(
      opts.output.replace(/\.png$/i, '.json'),
      JSON.stringify(
        {
          prompt: params.prompt,
          negative_prompt: params.negativePrompt,
          seed,
          width: size.width,
          height: size.height,
          engine: 'mossinfer',
          backend: opts.kind,
          tier: 'reference',
          ...jobInputsSidecar(params),
        },
        null,
        2,
      ),
      'utf8',
    )
  } catch {
    // best effort; the PNG carries the engine's own generation metadata
  }
}

function handleLine(active: ActiveCliJob, line: string): void {
  const { sink, params, opts } = active
  sink.stderr(line)
  const parsed = parseCliLine(opts.kind, line)
  const stage = (name: JobStage): void => {
    if (active.stage === name) return
    active.stage = name
    sink.event({ type: 'stage', name })
  }
  switch (parsed.kind) {
    case 'device': {
      const expected = opts.expectedDevice
      if (expected && !active.wrongDevice && !sameCliDevice(parsed, expected)) {
        const chose = parsed.arch ? `${parsed.name}（${parsed.arch}）` : parsed.name
        active.wrongDevice = `${CLI_PROGRAM[opts.kind]} 选中的是第 ${parsed.index} 号显卡「${chose}」，不是这个任务分配的「${expected.name}」，已在加载模型前停止。请到 设置 › 设备 重新检测显卡后再试`
        terminate(active, false)
        return
      }
      stage('load')
      return
    }
    case 'stage':
      stage(parsed.stage)
      if (parsed.stage === 'denoise') {
        sink.event({ type: 'progress', stage: 'denoise', current: 0, total: params.steps, percent: 0 })
      }
      return
    case 'step':
      stage('denoise')
      sink.event({
        type: 'progress',
        stage: 'denoise',
        current: parsed.step,
        total: parsed.total,
        percent: parsed.total ? Math.round((parsed.step / parsed.total) * 1000) / 10 : 0,
        eta_ms: Math.round((parsed.total - parsed.step) * parsed.seconds * 1000),
      })
      return
    case 'warning':
      sink.event({ type: 'log', level: 'warn', message: parsed.message })
      return
    case 'done':
      active.done = parsed
      return
    case 'error':
      active.errorMessage ??= parsed.message
      return
    default:
      return
  }
}

async function finishActive(slot: CliSlot, active: ActiveCliJob, code: number | null, signal: string | null): Promise<void> {
  if (active.killTimer) clearTimeout(active.killTimer)
  const { sink, params, opts } = active
  try {
    if (active.wrongDevice) {
      fail(sink, 'E_DEVICE', active.wrongDevice)
      return
    }
    if (active.spawnError) {
      fail(sink, 'E_ENGINE', `无法启动 ${CLI_PROGRAM[opts.kind]}：${active.spawnError.message}`)
      return
    }
    // The picture is written before the summary line: once both are there the job succeeded,
    // even when a cancel or a kill reached the program after that (or as it exited 0).
    if ((code === 0 || active.done !== null) && existsSync(opts.output)) {
      const seed = active.done?.seed ?? params.seed
      await writeSidecar(active, seed)
      sink.event({ type: 'stage', name: 'save' })
      const size = outputSizeOf(params)
      const ms = (value: number | undefined): number => (value === undefined ? 0 : Math.round(value * 1000))
      const timings = active.done?.timings ?? {}
      sink.event({
        type: 'result',
        images: [{ path: opts.output, width: size.width, height: size.height, seed }],
        timings: {
          load_ms: ms(timings.ditLoadS),
          text_encode_ms: ms(timings.textEncoderS),
          denoise_ms: ms(timings.denoiseS),
          decode_ms: ms(timings.vaeS),
          total_ms: Date.now() - active.startedAt,
        },
      })
      sink.done(0)
      return
    }
    if (active.cancelRequested) {
      sink.event({ type: 'canceled', at_stage: active.stage })
      sink.done(130)
      return
    }
    const failure = classifyCliFailure(opts.kind, code, active.errorMessage, signal)
    fail(sink, failure.code, failure.message, code === null || code === 0 ? 1 : code)
  } finally {
    if (slot.active === active) slot.active = null
    pump(slot)
  }
}

function start(slot: CliSlot, next: QueuedCliJob): void {
  const { params, opts, sink } = next
  const unsupported = cliUnsupported(opts.kind, params)
  if (unsupported) return fail(sink, 'E_NOT_SUPPORTED', unsupported)
  if (!existsSync(opts.binary)) return fail(sink, 'E_ENGINE', `找不到 ${CLI_PROGRAM[opts.kind]}，请到 设置 › 设备 重新安装引擎`)
  const problem = bundleProblem(opts.model)
  if (problem) return fail(sink, 'E_MODEL', problem)

  try {
    mkdirSync(dirname(opts.output), { recursive: true })
  } catch (error) {
    return fail(sink, 'E_DISK', `无法创建输出文件夹：${error instanceof Error ? error.message : String(error)}`)
  }
  sink.event({ type: 'hello', protocol: 1, runner_version: `${CLI_PROGRAM[opts.kind]}-${opts.version ?? 'unknown'}` })
  const args = buildCliArgs(params, { model: opts.model, output: opts.output, device: opts.cliDeviceIndex })
  let child: ChildProcess
  try {
    child = spawn(opts.binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    })
  } catch (error) {
    return fail(sink, 'E_ENGINE', `无法启动 ${CLI_PROGRAM[opts.kind]}：${error instanceof Error ? error.message : String(error)}`)
  }
  const active: ActiveCliJob = {
    ...next,
    child,
    stage: 'idle',
    startedAt: Date.now(),
    cancelRequested: false,
    errorMessage: null,
    done: null,
    spawnError: null,
    wrongDevice: null,
  }
  slot.active = active
  const out = new LineSplitter()
  const err = new LineSplitter()
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    for (const line of out.push(chunk)) sink.stderr(line.trimEnd())
  })
  child.stderr?.on('data', (chunk: string) => {
    for (const line of err.push(chunk)) handleLine(active, line.trimEnd())
  })
  child.once('spawn', () => {
    sink.event({
      type: 'ready',
      device: `${opts.kind}:${opts.cliDeviceIndex ?? 'auto'}`,
      dtype: 'bf16',
      capabilities: ['progress', 'cancel'],
    })
  })
  child.once('error', (error) => {
    active.spawnError = error
  })
  child.once('close', (code, signal) => {
    for (const line of out.flush()) sink.stderr(line.trimEnd())
    for (const line of err.flush()) handleLine(active, line.trimEnd())
    void finishActive(slot, active, code, signal)
  })
}

function pump(slot: CliSlot): void {
  while (!slot.active && slot.queue.length) {
    start(slot, slot.queue.shift()!)
  }
}

export async function runCliJob(job: JobRecord, params: JobParams, opts: CliJobOptions, sink: MossInferSink): Promise<void> {
  const slot = slotFor(opts.deviceUuid)
  if (slot.active || slot.queue.length) {
    sink.event({ type: 'log', level: 'info', message: `${CLI_PROGRAM[opts.kind]} 正在运行上一个任务，排队等待` })
  }
  slot.queue.push({ job, params, opts, sink })
  pump(slot)
}

function terminate(active: ActiveCliJob, cancel = true): void {
  if (cancel) active.cancelRequested = true
  try {
    active.child.kill('SIGTERM')
  } catch {
    // already gone; close follows
  }
  active.killTimer ??= setTimeout(() => {
    try {
      active.child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }, CLI_CANCEL_GRACE_MS)
}

/** Cancels a CLI job (running or waiting); false when no CLI engine has it. */
export function cancelCliJob(jobId: string): boolean {
  for (const slot of slots.values()) {
    if (slot.active?.job.id === jobId) {
      terminate(slot.active)
      return true
    }
    const index = slot.queue.findIndex((item) => item.job.id === jobId)
    if (index >= 0) {
      const [removed] = slot.queue.splice(index, 1)
      removed!.sink.event({ type: 'canceled', at_stage: 'idle' })
      removed!.sink.done(130)
      return true
    }
  }
  return false
}

/** True while a CLI job runs or waits on `deviceUuid` (any device when omitted). */
export function cliEngineBusy(deviceUuid?: string): boolean {
  const list = deviceUuid ? [slots.get(deviceUuid)] : [...slots.values()]
  return list.some((slot) => Boolean(slot && (slot.active || slot.queue.length)))
}

export interface CliShutdownFilter {
  kind?: CliEngineKind
  /** The binary being replaced, or the install folder holding it. */
  binary?: string
}

function within(path: string, target: string): boolean {
  const rel = relative(resolve(target), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Stops CLI jobs: all of them (app quit), or only those of one package about
 * to be replaced or removed (`kind`, and the binary or its install folder).
 * Waiting jobs are canceled, running ones terminated; resolves once they exited.
 */
export async function shutdownCliEngines(filter: CliShutdownFilter = {}): Promise<void> {
  const matches = (opts: CliJobOptions): boolean =>
    (!filter.kind || opts.kind === filter.kind) && (!filter.binary || within(opts.binary, filter.binary))
  const exits: Array<Promise<void>> = []
  for (const slot of slots.values()) {
    const keep: QueuedCliJob[] = []
    for (const queued of slot.queue.splice(0)) {
      if (!matches(queued.opts)) {
        keep.push(queued)
        continue
      }
      queued.sink.event({ type: 'canceled', at_stage: 'idle' })
      queued.sink.done(130)
    }
    slot.queue.push(...keep)
    const active = slot.active
    if (!active || !matches(active.opts)) continue
    exits.push(new Promise<void>((resolve) => {
      if (active.child.exitCode !== null || active.child.signalCode !== null) return resolve()
      active.child.once('close', () => resolve())
      terminate(active)
    }))
  }
  await Promise.all(exits)
}

const hipLists = new Map<string, Promise<HipDevice[]>>()

/**
 * `moss-infer-hip --list-devices`, once per binary version and environment
 * (LD_LIBRARY_PATH decides which ROCm it loads). A failed run is not kept, so
 * the next job asks again; it rejects with the program's own message.
 */
function hipDevices(binary: string, env?: Record<string, string>): Promise<HipDevice[]> {
  const key = JSON.stringify([binary, String(statSync(binary).mtimeMs), env ?? {}])
  const cached = hipLists.get(key)
  if (cached) return cached
  const devices = new Promise<HipDevice[]>((resolvePromise, rejectPromise) => {
    execFile(binary, ['--list-devices'], {
      timeout: 15_000,
      windowsHide: true,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    }, (error, stdout, stderr) => {
      if (error) {
        const said = String(stderr ?? '').split(/\r?\n/).find((line) => line.trim())?.trim()
        rejectPromise(new Error(said || error.message))
      } else {
        resolvePromise(parseHipDeviceList(String(stdout)))
      }
    })
  })
  hipLists.set(key, devices)
  devices.catch(() => hipLists.delete(key))
  return devices
}

export type HipIndexResult = { ok: true; index?: number } | { ok: false; message: string }

/**
 * The `--device` index moss-infer-hip knows our GPU by (HIP's order is not
 * Vulkan's): the `ordinal`-th usable card of its gfx target. Without a gfx
 * target nothing can be told and the program takes its first usable device.
 * A card the list does not have is an error: it must not land on another one.
 */
export async function hipDeviceIndex(binary: string, gpu: { name?: string; gfxTarget?: string }, ordinal: number, env?: Record<string, string>): Promise<HipIndexResult> {
  if (!gpu.gfxTarget) return { ok: true }
  let devices: HipDevice[]
  try {
    devices = await hipDevices(binary, env)
  } catch (error) {
    return { ok: false, message: `无法读取 moss-infer-hip 的显卡列表：${error instanceof Error ? error.message : String(error)}` }
  }
  const index = pickHipIndex(devices, gpu.gfxTarget, ordinal)
  if (index !== undefined) return { ok: true, index }
  const label = `${gpu.name ? `「${gpu.name}」，` : ''}${gpu.gfxTarget}，同型号第 ${ordinal + 1} 张`
  return { ok: false, message: `moss-infer-hip 没有找到这张显卡（${label}），请到 设置 › 设备 重新检测显卡后再试` }
}

/**
 * Why a bundle folder's DiT or text encoder is not the bf16 the CLI reads,
 * from the safetensors headers of their first file; null when both are bf16.
 * A file that cannot be read is a problem too: the CLI could not read it either.
 */
export async function cliBundleDtypeProblem(kind: CliEngineKind, model: string): Promise<string | null> {
  for (const [part, label] of [['transformer', 'DiT'], ['text_encoder', '文本编码器']] as const) {
    const dir = join(model, part)
    let file: string | undefined
    try {
      file = (await readdir(dir)).filter((name) => name.endsWith('.safetensors')).sort()[0]
    } catch {
      file = undefined
    }
    if (!file) return `模型包缺少 ${part} 的权重文件，请在模型库重新下载`
    let dtypes: Set<string>
    try {
      dtypes = await safetensorsDtypes(join(dir, file))
    } catch (error) {
      return `读不了 ${part}/${file}：${error instanceof Error ? error.message : String(error)}`
    }
    const other = [...dtypes].filter((dtype) => dtype !== 'BF16' && dtype !== 'F32')
    if (!dtypes.has('BF16') || other.length) {
      return `这个模型的${label}是 ${[...dtypes].join('/')}，${CLI_ENGINE_LABEL[kind]}引擎只能用 bf16 的 MOSS-Image，请换一个模型`
    }
  }
  return null
}

/** The tensor dtypes a .safetensors file declares (its JSON header only). */
async function safetensorsDtypes(path: string): Promise<Set<string>> {
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(8)
    if ((await handle.read(head, 0, 8, 0)).bytesRead !== 8) throw new Error('文件不完整')
    const length = Number(head.readBigUInt64LE(0))
    if (!Number.isSafeInteger(length) || length <= 0 || length > 100 * 1024 * 1024) throw new Error('不是 safetensors 文件')
    const json = Buffer.alloc(length)
    if ((await handle.read(json, 0, length, 8)).bytesRead !== length) throw new Error('文件不完整')
    const header = JSON.parse(json.toString('utf8')) as Record<string, { dtype?: unknown }>
    return new Set(Object.entries(header)
      .filter(([name]) => name !== '__metadata__')
      .map(([, tensor]) => String(tensor?.dtype ?? '')))
  } finally {
    await handle.close()
  }
}
