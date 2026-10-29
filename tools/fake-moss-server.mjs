#!/usr/bin/env node
// Fake moss-server for MossStudio scenario tests (--scenario=mossinfer-job / mossinfer-cancel).
// Speaks the moss-server JSON-lines protocol (protocol 2): hello/load/generate/cancel/
// status/unload/shutdown, with plan/progress/done events. Writes a real (synthetic) PNG.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { deflateSync } from 'node:zlib'
import readline from 'node:readline'

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ id, result: value })
}

function error(id, code, message) {
  send({ id, error: { code, message } })
}

function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let c = 0xffffffff
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(tag, payload) {
  const body = Buffer.concat([Buffer.from(tag, 'ascii'), payload])
  const head = Buffer.alloc(4)
  head.writeUInt32BE(payload.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, crc])
}

function writePng(path, width, height) {
  const w = Math.max(1, Math.min(512, width))
  const h = Math.max(1, Math.min(512, height))
  const rows = []
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3)
    for (let x = 0; x < w; x++) {
      row[1 + x * 3] = (20 + x) % 256
      row[1 + x * 3 + 1] = (70 + y) % 256
      row[1 + x * 3 + 2] = 240
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows), { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, png)
}

const HELLO = {
  protocol_version: 2,
  server: 'fake-moss-server',
  version: '2.0.0',
  abi_version: 1,
  capabilities: {
    preview: false,
    comfyui_models: false,
    model_files: true,
    lora: true,
    tiers: true,
    samplers: true,
    image_input: false,
    hires: false,
    distill: false,
    system_cuda: true,
  },
  probe: {
    driver_cuda_version: 13040,
    runtime_cuda_version: 13040,
    driver_compatible: true,
    device_count: 1,
    supported_device_count: 1,
    build_flavour: 'cu13',
    recommended_flavour: 'cu13',
    message: 'fake',
    cublaslt: { source: 'bundled', version: 130800, path: '/fake/libcublasLt.so.13', error: '' },
  },
}

let loaded = null // { model, mode, device }
let generating = null // { id, params, step, totalSteps, phaseQueue, timer, cancelled }

function startGeneration(id, params) {
  const steps = Math.max(1, Number(params.steps ?? 4))
  const gen = {
    id,
    params,
    step: 0,
    totalSteps: steps,
    tick: 0,
    cancelled: false,
    timer: null,
  }
  generating = gen
  // ticks: 0 = plan+text_encoder, 1 = dit_load, 2 = denoise step 0, then one step per tick, last = decode+done
  gen.timer = setInterval(() => {
    if (gen.cancelled) {
      clearInterval(gen.timer)
      send({
        event: 'done',
        id: gen.id,
        status: 'cancelled',
        steps_run: gen.step,
        report: null,
        warnings: [],
      })
      generating = null
      return
    }
    const t = gen.tick++
    const elapsed = t * 0.1
    if (t === 0) {
      send({ event: 'plan', id: gen.id, explanation: 'fake plan', plan: {} })
      send({ event: 'progress', id: gen.id, phase: 'text_encoder', step: 0, total_steps: steps, step_seconds: 0, elapsed_seconds: elapsed })
      return
    }
    if (t === 1) {
      send({ event: 'progress', id: gen.id, phase: 'dit_load', step: 0, total_steps: steps, step_seconds: 0, elapsed_seconds: elapsed })
      return
    }
    if (t >= 2 && t < 2 + steps) {
      gen.step = t - 1
      send({
        event: 'progress',
        id: gen.id,
        phase: 'denoise',
        step: gen.step - 1,
        total_steps: steps,
        step_seconds: 0.1,
        elapsed_seconds: elapsed,
      })
      // also emit the completed-step progress so current reaches total
      if (gen.step >= 1) {
        send({
          event: 'progress',
          id: gen.id,
          phase: 'denoise',
          step: gen.step,
          total_steps: steps,
          step_seconds: 0.1,
          elapsed_seconds: elapsed + 0.05,
        })
      }
      return
    }
    clearInterval(gen.timer)
    send({ event: 'progress', id: gen.id, phase: 'decode', step: 0, total_steps: steps, step_seconds: 0, elapsed_seconds: elapsed })
    const output = String(gen.params.output)
    writePng(output, Number(gen.params.width ?? 64), Number(gen.params.height ?? 64))
    const seed = typeof gen.params.seed === 'number' ? gen.params.seed : 42
    send({
      event: 'done',
      id: gen.id,
      status: 'ok',
      image: output,
      report: {
        seed_used: seed,
        timings_s: { total: 1, dit_load: 0.1, text_encode: 0.2, denoise: 0.6, decode: 0.1 },
        quality: { tier: loaded?.tier ?? 'high' },
      },
      warnings: [],
    })
    generating = null
  }, 100)
}

function handle(message) {
  const id = message.id ?? null
  const method = message.method
  const params = message.params ?? {}
  switch (method) {
    case 'hello': {
      const reply = { ...HELLO }
      if (params.devices) {
        reply.probe = {
          ...HELLO.probe,
          devices: [
            {
              index: 0,
              name: 'Fake GPU',
              pci_bus_id: '0000:00:00.0',
              compute_capability: '8.9',
              total_memory_bytes: 17179869184,
              free_memory_bytes: 8589934592,
              supported: true,
              unsupported_reason: '',
            },
          ],
        }
      }
      result(id, reply)
      return
    }
    case 'load': {
      if (!params.model || !existsSync(String(params.model))) {
        error(id, 'invalid_argument', `model path does not exist: ${String(params.model ?? '')}`)
        return
      }
      // protocol 2: tier is required and must be reference | high | turbo
      const tier = params.tier
      if (tier === undefined || tier === null) {
        error(id, 'invalid_params', `"tier" is required: reference, high or turbo`)
        return
      }
      if (!['reference', 'high', 'turbo'].includes(String(tier))) {
        error(id, 'invalid_params', `unknown tier: ${String(tier)} (reference, high or turbo)`)
        return
      }
      loaded = { model: String(params.model), mode: params.mode ?? 'balanced', device: params.device ?? 0, tier: String(tier) }
      send({ event: 'log', id, level: 'info', message: `engine created for ${loaded.model} (fake)` })
      result(id, loaded)
      return
    }
    case 'generate': {
      if (generating) {
        error(id, 'busy', 'a generation is already running')
        return
      }
      if (!loaded) {
        error(id, 'no_engine', 'no engine loaded')
        return
      }
      if (!params.output || !params.prompt) {
        error(id, 'invalid_params', 'output and prompt are required')
        return
      }
      result(id, { accepted: true })
      startGeneration(id, params)
      return
    }
    case 'cancel': {
      if (generating && (params.id === undefined || params.id === generating.id)) {
        generating.cancelled = true
        result(id, { cancelling: true, generating_id: generating.id })
      } else {
        result(id, { cancelling: false, ...(generating ? { generating_id: generating.id } : {}) })
      }
      return
    }
    case 'status': {
      result(id, {
        state: generating ? 'generating' : loaded ? 'idle' : 'unloaded',
        ...(loaded ? { model: loaded.model, mode: loaded.mode } : {}),
        ...(generating
          ? { generating_id: generating.id, phase: 'denoise', step: generating.step, total_steps: generating.totalSteps, elapsed_seconds: 1, cancelling: generating.cancelled }
          : {}),
      })
      return
    }
    case 'unload': {
      const had = !!loaded
      loaded = null
      result(id, { unloaded: had })
      return
    }
    case 'shutdown': {
      if (generating) {
        clearInterval(generating.timer)
        send({ event: 'done', id: generating.id, status: 'cancelled', steps_run: generating.step, report: null, warnings: [] })
        generating = null
      }
      result(id, {})
      process.exit(0)
    }
    default:
      error(id, 'method_not_found', `unknown method: ${String(method)}`)
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  try {
    handle(JSON.parse(line))
  } catch (err) {
    error(null, 'parse_error', String(err))
  }
})
rl.on('close', () => process.exit(0))
