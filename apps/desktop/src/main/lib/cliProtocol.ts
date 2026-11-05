import type { JobParams } from '@shared/types'
import { CLI_ENGINE_LABEL, type CliEngineKind } from '@shared/cliEngine'

/**
 * How the app talks to `moss-infer-vulkan` / `moss-infer-hip`: the argument
 * list of one job, and what each stderr line of a run means. Both programs
 * share one CLI (vulkan/tools/moss_infer_vulkan.cpp, hip/tools/moss_infer_hip.cpp):
 *
 *   vulkan: device 0, NVIDIA GeForce RTX 4090 Laptop GPU; kernels: coop
 *   hip: device 0, Radeon RX 7900 XTX (gfx1100); kernels: gfx1100, wmma
 *   warning: prompt truncated to 4096 of 4200 tokens (104 dropped; --max-seq 4096)
 *   text encoder
 *   denoise
 *   denoise 1/3 1.80 s
 *   vae
 *   done: seed 7; text encoder 10.3 s, DiT load 17.8 s (42 of 42 blocks on the device), denoise 5.2 s (1.74 s/step), VAE 1.5 s
 *
 * and on failure `moss-infer-vulkan: <message>` with exit 1 (failed) or 2
 * (usage error or unsupported request, followed by the usage text). Pure.
 */

export const CLI_PROGRAM: Record<CliEngineKind, string> = {
  vulkan: 'moss-infer-vulkan',
  hip: 'moss-infer-hip',
}

export interface CliArgsOptions {
  /** The bundle folder (diffusers layout, bf16 files). */
  model: string
  /** PNG the program writes. */
  output: string
  /** The CLI's own device index (from its `--list-devices`); omitted = its first usable device. */
  device?: number
}

/**
 * The argument list of one job. Only what the CLI takes is passed; everything
 * else must have been refused before (see `cliUnsupported`).
 */
export function buildCliArgs(params: JobParams, options: CliArgsOptions): string[] {
  const args = [
    '--model', options.model,
    '--prompt', params.prompt,
    '--negative', params.negativePrompt ?? '',
    '--width', String(params.width),
    '--height', String(params.height),
    '--steps', String(params.steps),
    '--cfg', String(params.cfg),
    '--seed', String(params.seed),
  ]
  if (params.sampling?.shift !== undefined) args.push('--shift', String(params.sampling.shift))
  if (options.device !== undefined && options.device >= 0) args.push('--device', String(options.device))
  args.push('-o', options.output)
  return args
}

/**
 * What in a job a CLI engine cannot do, as one sentence naming every such
 * input, or null when the job is plain text to image.
 */
export function cliUnsupported(kind: CliEngineKind, params: JobParams): string | null {
  const names: string[] = []
  if (params.adapters?.length) names.push('LoRA')
  if (params.initImage) names.push('起始图')
  if (params.mask) names.push('遮罩')
  if (params.control) names.push('控制图')
  if (params.references?.paths.length) names.push('参考图')
  const sampling = params.sampling
  if (sampling?.hires) names.push('高清修复')
  if ((sampling?.sampler && sampling.sampler !== 'euler') || (sampling?.scheduler && sampling.scheduler !== 'moss')) {
    names.push('更换采样器')
  }
  if (sampling?.stepCache && sampling.stepCache !== 'off') names.push('步缓存')
  if (sampling?.cfgTruncation !== undefined) names.push('CFG 截断')
  if (!names.length) return null
  return `${CLI_ENGINE_LABEL[kind]}引擎只能文生图，不支持${names.join('、')}，请移除后再生成`
}

export type CliLine =
  /** The device the program chose, printed before anything loads; `arch` is HIP's gfx target. */
  | { kind: 'device'; index: number; name: string; kernels: string; arch?: string }
  | { kind: 'warning'; message: string }
  | { kind: 'stage'; stage: 'text' | 'denoise' | 'decode' }
  | { kind: 'step'; step: number; total: number; seconds: number }
  | { kind: 'done'; seed: number; timings: CliTimings }
  | { kind: 'error'; message: string }
  | { kind: 'other'; text: string }

export interface CliTimings {
  textEncoderS?: number
  ditLoadS?: number
  denoiseS?: number
  vaeS?: number
}

const STEP = /^denoise (\d+)\/(\d+) (\d+(?:\.\d+)?) s$/
const DEVICE: Record<CliEngineKind, RegExp> = {
  vulkan: /^vulkan: device (\d+), (.*); kernels: (.*)$/,
  hip: /^hip: device (\d+), (.*) \(([^()]+)\); kernels: (.*)$/,
}
const ERROR: Record<CliEngineKind, RegExp> = {
  vulkan: /^moss-infer-vulkan: (.*)$/,
  hip: /^moss-infer-hip: (.*)$/,
}

function seconds(text: string, label: string): number | undefined {
  const match = new RegExp(`${label} (\\d+(?:\\.\\d+)?) s\\b`).exec(text)
  return match ? Number(match[1]) : undefined
}

/** One stderr line of a run, already stripped of its line ending. */
export function parseCliLine(kind: CliEngineKind, raw: string): CliLine {
  const line = raw.trimEnd()
  if (line === 'text encoder') return { kind: 'stage', stage: 'text' }
  if (line === 'denoise') return { kind: 'stage', stage: 'denoise' }
  if (line === 'vae') return { kind: 'stage', stage: 'decode' }
  const step = STEP.exec(line)
  if (step) return { kind: 'step', step: Number(step[1]), total: Number(step[2]), seconds: Number(step[3]) }
  const device = DEVICE[kind].exec(line)
  if (device) {
    return kind === 'hip'
      ? { kind: 'device', index: Number(device[1]), name: device[2]!, arch: device[3]!, kernels: device[4]! }
      : { kind: 'device', index: Number(device[1]), name: device[2]!, kernels: device[3]! }
  }
  if (line.startsWith('warning: ')) return { kind: 'warning', message: line.slice('warning: '.length) }
  const done = /^done: seed (\d+);(.*)$/.exec(line)
  if (done) {
    const rest = done[2]!
    return {
      kind: 'done',
      seed: Number(done[1]),
      timings: {
        textEncoderS: seconds(rest, 'text encoder'),
        ditLoadS: seconds(rest, 'DiT load'),
        denoiseS: seconds(rest, 'denoise'),
        vaeS: seconds(rest, 'VAE'),
      },
    }
  }
  const error = ERROR[kind].exec(line)
  if (error) return { kind: 'error', message: error[1]! }
  return { kind: 'other', text: line }
}

/** The CLI's request checks (pipeline::validate()'s messages), in plain words. */
const USAGE_MESSAGES: Array<[RegExp, string]> = [
  [/^Height and width must be positive multiples of 16\./, '宽和高必须是 16 的倍数'],
  [/^Height and width must be at most \d+\./, '宽和高最大 4096'],
  [/^Image size must be at most 4\.2 megapixels/, '画面最大约 420 万像素（例如 2048 × 2048）'],
  [/^Steps (?:and image count must be positive|must be at most)/, '步数必须在 1 到 10000 之间'],
  [/^Enter a prompt\./, '请先写描述'],
  [/^CFG must be finite and nonnegative; shift must be finite and positive\./, 'CFG 不能小于 0，Shift 必须大于 0'],
  [/^Seed must be -1/, '种子必须是 0 到 2^53-1 的整数'],
]

export interface CliFailure {
  code: string
  message: string
}

/**
 * The job error of a run that exited with `exitCode` (null = killed by a
 * signal), from the program's own message when it printed one.
 */
export function classifyCliFailure(kind: CliEngineKind, exitCode: number | null, message: string | null, signal?: string | null): CliFailure {
  const raw = message?.trim() ?? ''
  const detail = raw ? `：${raw}` : ''
  if (exitCode === null) {
    return { code: 'E_ENGINE', message: `${CLI_PROGRAM[kind]} 意外退出${signal ? `（${signal}）` : ''}` }
  }
  if (exitCode === 2) {
    const plain = USAGE_MESSAGES.find(([pattern]) => pattern.test(raw))?.[1]
    return { code: 'E_NOT_SUPPORTED', message: `引擎不接受这次的设置${plain ? `：${plain}（${raw}）` : detail}` }
  }
  if (/MiB of device memory|out of (?:device |host )?memory|OUT_OF_(?:DEVICE|HOST)_MEMORY|hipErrorOutOfMemory/i.test(raw)) {
    return { code: 'E_OOM', message: `显存不够这次生成，请把画面调小一些再试${detail}` }
  }
  if (/no (?:usable )?Vulkan device|Vulkan device \d+ .*cannot be used|no HIP devices?|hip: no (?:usable )?device|hip: device \d+:|libamdhip64|vulkan-1|libvulkan/i.test(raw)) {
    return { code: 'E_DEVICE', message: `引擎用不了这张显卡${detail}` }
  }
  if (/tokenizer: cannot open|cannot open|No such file|expected BF16|unexpected dtype/i.test(raw)) {
    return { code: 'E_MODEL', message: `模型文件不完整或不是 bf16 模型包${detail}` }
  }
  if (exitCode === 0) return { code: 'E_NO_RESULT', message: `${CLI_PROGRAM[kind]} 正常退出，但没有写出图片` }
  return { code: 'E_ENGINE', message: raw ? `生成失败${detail}` : `${CLI_PROGRAM[kind]} 退出码 ${exitCode}` }
}

export interface HipDevice {
  index: number
  name: string
  /** `gfx1100` */
  arch: string
  totalGiB: number
  usable: boolean
  kernels?: string
  reason?: string
}

const HIP_HEADER = /^device (\d+): (.*) \(([^()]+)\), (\d+(?:\.\d+)?) GiB$/

/**
 * `moss-infer-hip --list-devices` (hip/tools/moss_infer_hip.cpp list_devices):
 *
 *   device 0: AMD Radeon RX 7900 XTX (gfx1100), 24.0 GiB
 *     kernels: gfx1100, wmma
 *   device 1: AMD Radeon RX 6800 (gfx1030), 16.0 GiB
 *     unusable: this build's kernels are for gfx1100, the device is gfx1030
 *
 * and `no HIP devices` when there are none. The index is what `--device` takes;
 * it is HIP's order, which need not be Vulkan's.
 */
export function parseHipDeviceList(stdout: string): HipDevice[] {
  const devices: HipDevice[] = []
  let current: HipDevice | null = null
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const header = HIP_HEADER.exec(line)
    if (header) {
      current = { index: Number(header[1]), name: header[2]!.trim(), arch: header[3]!, totalGiB: Number(header[4]), usable: false }
      devices.push(current)
      continue
    }
    if (!current) continue
    const detail = line.trim()
    if (detail.startsWith('kernels: ')) {
      current.usable = true
      current.kernels = detail.slice('kernels: '.length)
    } else if (detail.startsWith('unusable: ')) {
      current.reason = detail.slice('unusable: '.length)
    }
  }
  return devices
}

/**
 * The HIP index of one of our GPUs: the usable HIP device with its gfx target;
 * with several such cards, the `ordinal`-th of them (cards of one gfx target,
 * counted in our inventory's order). Undefined when it cannot be told.
 */
export function pickHipIndex(devices: readonly HipDevice[], gfxTarget: string | undefined, ordinal = 0): number | undefined {
  if (!gfxTarget) return undefined
  const same = devices.filter((device) => device.usable && device.arch === gfxTarget)
  // No clamping: a card the list does not have must not fall back onto another one.
  return ordinal >= 0 ? same[ordinal]?.index : undefined
}

/** A GPU name without vendor marks, driver suffixes (`(RADV NAVI31)`) and case. */
function gpuNameKey(name: string): string {
  return name
    .replace(/\((?:R|TM|C)\)/gi, '')
    .replace(/\([^()]*\)/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Whether the device a CLI program says it chose is the GPU the job was
 * assigned to: the same card name, ignoring vendor marks and the driver's
 * suffix (Vulkan on Mesa says "AMD Radeon RX 7900 XTX (RADV NAVI31)", HIP
 * says "AMD Radeon RX 7900 XTX"), and the same gfx target when both are known.
 */
export function sameCliDevice(
  printed: { name: string; arch?: string },
  expected: { name: string; gfxTarget?: string },
): boolean {
  if (printed.arch && expected.gfxTarget && printed.arch !== expected.gfxTarget) return false
  const a = gpuNameKey(printed.name)
  const b = gpuNameKey(expected.name)
  if (!a || !b) return true
  return a === b || a.includes(b) || b.includes(a)
}
