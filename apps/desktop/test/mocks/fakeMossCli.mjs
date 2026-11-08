#!/usr/bin/env node
/**
 * A stand-in for moss-infer-vulkan / moss-infer-hip (MossInfer 2.2.0): the same
 * flags, checks, messages, exit codes and stderr lines as
 * vulkan/tools/moss_infer_vulkan.cpp and hip/tools/moss_infer_hip.cpp, and it
 * writes a real PNG of the requested size. A real run of moss-infer-vulkan
 * printed, on stderr:
 *
 *   vulkan: device 0, NVIDIA GeForce RTX 4090 Laptop GPU; kernels: coop
 *   text encoder
 *   denoise
 *   denoise 1/3 1.80 s
 *   denoise 2/3 1.71 s
 *   denoise 3/3 1.71 s
 *   vae
 *   done: seed 7; text encoder 10.3 s, DiT load 17.8 s (42 of 42 blocks on the device), denoise 5.2 s (1.74 s/step), VAE 1.5 s
 *
 * Run as `node fakeMossCli.mjs <args>`. FAKE_CLI_KIND = vulkan | hip (default
 * vulkan). FAKE_CLI_BEHAVIOR = path of a JSON file with:
 *   devices    [{ name, vendor, device, discrete, kernels?, unusable?, arch?, gib? }]
 *   stepMs     sleep per denoise step (default 5)
 *   failAt     'start' | 'text' | 'denoise' | 'vae': print `failMessage`, exit `failCode` (default 1)
 *   warning    print `warning: <warning>` before the text encoder (a truncated prompt)
 *   noise      print `<noise>` as a stray line the runner does not recognise, before the text encoder
 *   noPng      exit 0 without writing the PNG
 *   ignoreTerm keep running on SIGTERM (only SIGKILL stops it)
 *   listFail   `--list-devices` prints `<program>: <listFail>` and exits 1 (no runtime)
 *   argsFile   append the argument list as one JSON line
 *   pidFile    write the process id
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { deflateSync } from 'node:zlib'

const kind = process.env.FAKE_CLI_KIND === 'hip' ? 'hip' : 'vulkan'
const program = `moss-infer-${kind}`
const behavior = process.env.FAKE_CLI_BEHAVIOR ? JSON.parse(readFileSync(process.env.FAKE_CLI_BEHAVIOR, 'utf8')) : {}
const argv = process.argv.slice(2)
if (behavior.argsFile) appendFileSync(behavior.argsFile, `${JSON.stringify(argv)}\n`)
if (behavior.pidFile) writeFileSync(behavior.pidFile, String(process.pid))
if (behavior.ignoreTerm) process.on('SIGTERM', () => undefined)

const devices =
  behavior.devices ??
  (kind === 'vulkan'
    ? [{ name: 'NVIDIA GeForce RTX 4090 Laptop GPU', vendor: 0x10de, device: 0x2757, discrete: true, kernels: 'coop' }]
    : [{ name: 'AMD Radeon RX 7900 XTX', arch: 'gfx1100', gib: 24, kernels: 'gfx1100, wmma' }])

const usage =
  `usage: ${program} --model <bundle_dir> --prompt <text> [-o <out.png>] [--latent-out <latents.npy>]\n` +
  `       ${program} --list-devices | --version | --help\n`

class UsageError extends Error {}
const usageError = (message) => {
  throw new UsageError(message)
}

function int(flag, value) {
  if (!/^[+-]?\d+$/.test(value)) usageError(`${flag} takes an integer, got ${value}`)
  return Number(value)
}
function num(flag, value) {
  const n = Number(value)
  if (value.trim() === '' || !Number.isFinite(n)) usageError(`${flag} takes a number, got ${value}`)
  return n
}

function parse(args) {
  const a = {
    width: 1024,
    height: 1024,
    steps: 50,
    cfg: 3,
    shift: 5,
    seed: 42,
    device: -1,
    maxSeq: 4096,
    prompt: null,
    negative: '',
    quiet: false,
    list: false,
  }
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]
    if (flag === '--no-metadata') continue
    if (flag === '--quiet') {
      a.quiet = true
      continue
    }
    if (flag === '--list-devices') {
      a.list = true
      continue
    }
    if (flag === '-h' || flag === '--help') return { ...a, help: true }
    if (flag === '--version') return { ...a, version: true }
    if (i + 1 >= args.length) usageError(`${flag} needs a value`)
    const v = args[++i]
    if (flag === '--model') a.model = v
    else if (flag === '--prompt') a.prompt = v
    else if (flag === '--negative') a.negative = v
    else if (flag === '-o' || flag === '--output') a.out = v
    else if (flag === '--latent-out') a.latent = v
    else if (flag === '--size') {
      const x = v.indexOf('x')
      if (x < 0) usageError('--size takes <W>x<H>')
      a.width = int('--size', v.slice(0, x))
      a.height = int('--size', v.slice(x + 1))
    } else if (flag === '--width') a.width = int(flag, v)
    else if (flag === '--height') a.height = int(flag, v)
    else if (flag === '--steps') a.steps = int(flag, v)
    else if (flag === '--cfg') a.cfg = num(flag, v)
    else if (flag === '--shift') a.shift = num(flag, v)
    else if (flag === '--seed') a.seed = int(flag, v)
    else if (flag === '--skip-layers' || flag === '--vram-budget') continue
    else if (flag === '--max-seq') a.maxSeq = int(flag, v)
    else if (flag === '--device') a.device = int(flag, v)
    else if (flag === '--kernels' && kind === 'vulkan') {
      if (!['coop', 'coop-f16', 'plain'].includes(v)) usageError('--kernels takes coop, coop-f16 or plain')
      a.kernels = v
    } else if (flag === '--tier') {
      if (v !== 'reference') usageError(`${program} runs --tier reference only`)
    } else usageError(`unknown or unsupported flag ${flag}`)
  }
  if (a.list) return a
  if (!a.model || a.prompt === null) usageError('--model and --prompt are required')
  if (!a.out && !a.latent) usageError('at least one of -o / --latent-out is required')
  if (a.device < -1) usageError('--device takes a device index, or -1 for the first usable device')
  if (!a.prompt.trim()) usageError('Enter a prompt.')
  if (a.height <= 0 || a.width <= 0 || a.height % 16 !== 0 || a.width % 16 !== 0)
    usageError('Height and width must be positive multiples of 16.')
  if (a.height > 4096 || a.width > 4096) usageError('Height and width must be at most 4096.')
  if (a.height * a.width > 4_200_000)
    usageError('Image size must be at most 4.2 megapixels (e.g. 2048x2048); the model is meant for 0.25 to 4 megapixels.')
  if (a.steps < 1) usageError('Steps and image count must be positive.')
  if (a.steps > 10000) usageError('Steps must be at most 10000.')
  if (a.cfg < 0 || a.shift <= 0) usageError('CFG must be finite and nonnegative; shift must be finite and positive.')
  if (a.seed < -1 || a.seed >= 2 ** 53) usageError('Seed must be -1 (random) or an integer from 0 to 2^53-1 (browser-safe range).')
  return a
}

const hex = (n) => n.toString(16).padStart(4, '0')

function listDevices() {
  if (behavior.listFail) {
    err(`${program}: ${behavior.listFail}`)
    return 1
  }
  if (!devices.length) process.stdout.write(`no ${kind === 'vulkan' ? 'Vulkan' : 'HIP'} devices\n`)
  devices.forEach((d, index) => {
    if (kind === 'vulkan')
      process.stdout.write(`device ${index}: ${d.name} [${hex(d.vendor)}:${hex(d.device)}]${d.discrete ? ' discrete' : ''}\n`)
    else process.stdout.write(`device ${index}: ${d.name} (${d.arch}), ${(d.gib ?? 0).toFixed(1)} GiB\n`)
    process.stdout.write(d.unusable ? `  unusable: ${d.unusable}\n` : `  kernels: ${d.kernels}\n`)
  })
  return 0
}

class Failure extends Error {}

function pickDevice(index) {
  if (kind === 'vulkan') {
    if (index >= devices.length) throw new Failure(`no Vulkan device ${index}: there are ${devices.length}`)
    if (index >= 0) {
      if (devices[index].unusable)
        throw new Failure(`Vulkan device ${index} (${devices[index].name}) cannot be used: ${devices[index].unusable}`)
      return index
    }
    const usable = devices.map((d, i) => ({ d, i })).filter(({ d }) => !d.unusable)
    const chosen = usable.find(({ d }) => d.discrete) ?? usable[0]
    if (!chosen) throw new Failure('no usable Vulkan device')
    return chosen.i
  }
  if (!devices.length) throw new Failure('hip: no device (gfx1100 build)')
  if (index < 0) {
    const i = devices.findIndex((d) => !d.unusable)
    if (i < 0) throw new Failure(`hip: no usable device; device 0: ${devices[0].unusable}`)
    return i
  }
  if (index >= devices.length) throw new Failure(`hip: no device ${index} (${devices.length} found)`)
  if (devices[index].unusable) throw new Failure(`hip: device ${index}: ${devices[index].unusable}`)
  return index
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const err = (line) => process.stderr.write(`${line}\n`)

function crc32(buffer) {
  let c = ~0
  for (const byte of buffer) {
    c ^= byte
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
function png(width, height, text) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height, 0x80)
  for (let y = 0; y < height; y += 1) raw[y * (width * 3 + 1)] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('tEXt', Buffer.from(`parameters\0${text}`, 'latin1')),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function run(a) {
  const index = pickDevice(a.device)
  const d = devices[index]
  if (kind === 'vulkan') err(`vulkan: device ${index}, ${d.name}; kernels: ${a.kernels ?? d.kernels}`)
  else err(`hip: device ${index}, ${d.name} (${d.arch}); kernels: ${d.kernels}`)
  const failAt = (stage) => {
    if (behavior.failAt !== stage) return
    const error = new Failure(behavior.failMessage ?? 'failed')
    error.exitCode = behavior.failCode ?? 1
    throw error
  }
  failAt('start')
  if (behavior.warning) err(`warning: ${behavior.warning}`)
  if (behavior.noise) err(behavior.noise)
  const seed = a.seed >= 0 ? a.seed : Math.floor(Math.random() * 2 ** 32)
  if (!a.quiet) err('text encoder')
  failAt('text')
  if (!a.quiet) err('denoise')
  const stepMs = behavior.stepMs ?? 5
  for (let step = 1; step <= a.steps; step += 1) {
    await sleep(stepMs)
    if (step === Math.ceil(a.steps / 2)) failAt('denoise')
    if (!a.quiet) err(`denoise ${step}/${a.steps} ${(stepMs / 1000).toFixed(2)} s`)
  }
  if (a.out) {
    if (!a.quiet) err('vae')
    failAt('vae')
    if (!behavior.noPng) {
      mkdirSync(dirname(a.out), { recursive: true })
      writeFileSync(
        a.out,
        png(a.width, a.height, `${a.prompt}\nSteps: ${a.steps}, Seed: ${seed}, Size: ${a.width}x${a.height}, backend: ${kind}`),
      )
    }
  }
  const denoise = (a.steps * stepMs) / 1000
  if (!a.quiet) {
    const free = kind === 'hip' ? ', 3.25 GiB free beside them' : ''
    err(
      `done: seed ${seed}; text encoder 0.4 s, DiT load 1.2 s (42 of 42 blocks on the device${free}), denoise ${denoise.toFixed(1)} s (${(denoise / a.steps).toFixed(2)} s/step), VAE 0.3 s`,
    )
  }
  return 0
}

async function main() {
  let a
  try {
    a = parse(argv)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    err(`${program}: ${error.message}`)
    process.stderr.write(usage)
    return 2
  }
  if (a.help) {
    process.stdout.write(usage)
    return 0
  }
  if (a.version) {
    process.stdout.write(`${program} 2.2.0\n`)
    return 0
  }
  try {
    return a.list ? listDevices() : await run(a)
  } catch (error) {
    err(`${program}: ${error.message}`)
    return error.exitCode ?? 1
  }
}

process.exitCode = await main()
