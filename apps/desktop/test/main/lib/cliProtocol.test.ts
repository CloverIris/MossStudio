import { describe, expect, it } from 'vitest'
import type { JobParams } from '@shared/types'
import { buildCliArgs, classifyCliFailure, cliUnsupported, parseCliLine, parseHipDeviceList, pickHipIndex, sameCliDevice } from '@main/lib/cliProtocol'

const params: JobParams = { prompt: 'a red apple', negativePrompt: 'blurry', width: 512, height: 768, steps: 3, cfg: 3.5, seed: 7, profile: 'base' }

/** stderr of a real `moss-infer-vulkan` 2.2.0 run (RTX 4090 Laptop, 512x512, 3 steps), verbatim. */
const REAL_VULKAN_RUN = [
  'vulkan: device 0, NVIDIA GeForce RTX 4090 Laptop GPU; kernels: coop',
  'text encoder',
  'denoise',
  'denoise 1/3 1.80 s',
  'denoise 2/3 1.71 s',
  'denoise 3/3 1.71 s',
  'vae',
  'done: seed 7; text encoder 10.3 s, DiT load 17.8 s (42 of 42 blocks on the device), denoise 5.2 s (1.74 s/step), VAE 1.5 s',
]

describe('buildCliArgs', () => {
  it('passes only what the CLI takes, in its spelling', () => {
    expect(buildCliArgs(params, { model: '/m/bundle', output: '/o/job-1.png' })).toEqual([
      '--model', '/m/bundle', '--prompt', 'a red apple', '--negative', 'blurry',
      '--width', '512', '--height', '768', '--steps', '3', '--cfg', '3.5', '--seed', '7',
      '-o', '/o/job-1.png',
    ])
  })

  it('adds --shift when the canvas sets one and --device for a known CLI index', () => {
    const args = buildCliArgs({ ...params, sampling: { shift: 4.5 } }, { model: '/m', output: '/o.png', device: 1 })
    expect(args.slice(-6)).toEqual(['--shift', '4.5', '--device', '1', '-o', '/o.png'])
  })

  it('leaves --device out when the index is unknown or negative (the CLI picks its first usable device)', () => {
    expect(buildCliArgs(params, { model: '/m', output: '/o.png', device: -1 })).not.toContain('--device')
    expect(buildCliArgs(params, { model: '/m', output: '/o.png' })).not.toContain('--device')
  })

  it('sends an empty negative prompt as an empty value, and keeps prompts with spaces and quotes as one argument', () => {
    const args = buildCliArgs({ ...params, prompt: 'a "quoted" cat --steps 9', negativePrompt: '' }, { model: '/m', output: '/o.png' })
    expect(args[3]).toBe('a "quoted" cat --steps 9')
    expect(args[5]).toBe('')
  })
})

describe('cliUnsupported', () => {
  it('lets plain text to image through, including euler/moss and step cache off', () => {
    expect(cliUnsupported('vulkan', params)).toBeNull()
    expect(cliUnsupported('vulkan', { ...params, adapters: [], sampling: { sampler: 'euler', scheduler: 'moss', stepCache: 'off', shift: 3 } })).toBeNull()
  })

  it.each([
    ['LoRA', { adapters: [{ path: '/l.safetensors', strength: 1 }] }],
    ['起始图', { initImage: { path: '/i.png', strength: 0.5 } }],
    ['遮罩', { mask: { path: '/m.png' } }],
    ['控制图', { control: { adapter: '/c.safetensors', images: [] } }],
    ['参考图', { references: { paths: ['/r.png'] } }],
    ['高清修复', { sampling: { hires: { width: 2048, height: 2048 } } }],
    ['更换采样器', { sampling: { sampler: 'heun' } }],
    ['更换采样器', { sampling: { scheduler: 'karras' } }],
    ['步缓存', { sampling: { stepCache: 'fbcache' } }],
    ['CFG 截断', { sampling: { cfgTruncation: 0.5 } }],
  ] as Array<[string, Partial<JobParams>]>)('refuses %s', (name, patch) => {
    expect(cliUnsupported('vulkan', { ...params, ...patch })).toBe(`兼容模式引擎只能文生图，不支持${name}，请移除后再生成`)
  })

  it('names every unsupported input at once, with the engine the device runs', () => {
    expect(cliUnsupported('hip', { ...params, adapters: [{ path: '/l', strength: 1 }], initImage: { path: '/i.png', strength: 1 }, references: { paths: ['/r.png'] } }))
      .toBe('AMD 原生引擎只能文生图，不支持LoRA、起始图、参考图，请移除后再生成')
  })
})

describe('parseCliLine', () => {
  it('reads a real moss-infer-vulkan run line by line', () => {
    expect(REAL_VULKAN_RUN.map((line) => parseCliLine('vulkan', line))).toEqual([
      { kind: 'device', index: 0, name: 'NVIDIA GeForce RTX 4090 Laptop GPU', kernels: 'coop' },
      { kind: 'stage', stage: 'text' },
      { kind: 'stage', stage: 'denoise' },
      { kind: 'step', step: 1, total: 3, seconds: 1.8 },
      { kind: 'step', step: 2, total: 3, seconds: 1.71 },
      { kind: 'step', step: 3, total: 3, seconds: 1.71 },
      { kind: 'stage', stage: 'decode' },
      { kind: 'done', seed: 7, timings: { textEncoderS: 10.3, ditLoadS: 17.8, denoiseS: 5.2, vaeS: 1.5 } },
    ])
  })

  it('reads the hip program’s device and summary lines (hip_moss_infer_hip.cpp)', () => {
    expect(parseCliLine('hip', 'hip: device 1, AMD Radeon RX 7900 XTX (gfx1100); kernels: gfx1100, wmma'))
      .toEqual({ kind: 'device', index: 1, name: 'AMD Radeon RX 7900 XTX', arch: 'gfx1100', kernels: 'gfx1100, wmma' })
    expect(parseCliLine('hip', 'done: seed 4294967295; text encoder 3.1 s, DiT load 9.0 s (40 of 42 blocks on the device, 0.75 GiB free beside them), denoise 80.0 s (1.60 s/step), VAE 2.0 s'))
      .toEqual({ kind: 'done', seed: 4294967295, timings: { textEncoderS: 3.1, ditLoadS: 9, denoiseS: 80, vaeS: 2 } })
  })

  it('keeps the vulkan kernels note and Windows line endings', () => {
    expect(parseCliLine('vulkan', 'vulkan: device 1, Intel(R) Arc(TM) A770 Graphics; kernels: plain (no coop: no VK_KHR_cooperative_matrix)\r'))
      .toEqual({ kind: 'device', index: 1, name: 'Intel(R) Arc(TM) A770 Graphics', kernels: 'plain (no coop: no VK_KHR_cooperative_matrix)' })
  })

  it('reads warnings and the program’s own error line', () => {
    expect(parseCliLine('vulkan', 'warning: prompt truncated to 4096 of 4200 tokens (104 dropped; --max-seq 4096)'))
      .toEqual({ kind: 'warning', message: 'prompt truncated to 4096 of 4200 tokens (104 dropped; --max-seq 4096)' })
    expect(parseCliLine('vulkan', 'moss-infer-vulkan: tokenizer: cannot open /nonexistent/tokenizer/tokenizer.json'))
      .toEqual({ kind: 'error', message: 'tokenizer: cannot open /nonexistent/tokenizer/tokenizer.json' })
    expect(parseCliLine('hip', 'moss-infer-hip: hip: no usable device; device 0: this build’s kernels are for gfx1100, the device is gfx1030'))
      .toEqual({ kind: 'error', message: 'hip: no usable device; device 0: this build’s kernels are for gfx1100, the device is gfx1030' })
  })

  it('does not take one program’s lines for the other’s, and passes anything else through', () => {
    expect(parseCliLine('hip', 'moss-infer-vulkan: boom')).toEqual({ kind: 'other', text: 'moss-infer-vulkan: boom' })
    expect(parseCliLine('hip', REAL_VULKAN_RUN[0]!)).toEqual({ kind: 'other', text: REAL_VULKAN_RUN[0] })
    expect(parseCliLine('vulkan', 'usage: moss-infer-vulkan --model <bundle_dir> --prompt <text>')).toMatchObject({ kind: 'other' })
    expect(parseCliLine('vulkan', 'denoise 1/3')).toMatchObject({ kind: 'other' })
  })
})

describe('classifyCliFailure', () => {
  it('exit 2 is a request the engine does not take, with its message', () => {
    expect(classifyCliFailure('vulkan', 2, 'Height and width must be positive multiples of 16.'))
      .toEqual({ code: 'E_NOT_SUPPORTED', message: '引擎不接受这次的设置：宽和高必须是 16 的倍数（Height and width must be positive multiples of 16.）' })
    expect(classifyCliFailure('vulkan', 2, 'Image size must be at most 4.2 megapixels (e.g. 2048x2048); the model is meant for 0.25 to 4 megapixels.').message)
      .toMatch(/^引擎不接受这次的设置：画面最大约 420 万像素/)
    expect(classifyCliFailure('hip', 2, 'Steps must be at most 10000.').message).toMatch(/步数必须在 1 到 10000 之间/)
    expect(classifyCliFailure('vulkan', 2, 'unknown or unsupported flag --sampler'))
      .toEqual({ code: 'E_NOT_SUPPORTED', message: '引擎不接受这次的设置：unknown or unsupported flag --sampler' })
    expect(classifyCliFailure('vulkan', 2, 'Intel Arc cannot run --kernels coop: no bf16 cooperative matrix'))
      .toMatchObject({ code: 'E_NOT_SUPPORTED' })
  })

  it('a run the device memory cannot hold is E_OOM (generate.cpp’s refusals)', () => {
    expect(classifyCliFailure('vulkan', 1, 'the DiT at 2048x2048 needs at least 9000 MiB of device memory (its activations, every block streamed); 4000 MiB are free'))
      .toMatchObject({ code: 'E_OOM' })
    expect(classifyCliFailure('vulkan', 1, 'vkAllocateMemory: VK_ERROR_OUT_OF_DEVICE_MEMORY')).toMatchObject({ code: 'E_OOM' })
  })

  it.each([
    ['vulkan', 'no Vulkan device 5: there are 1'],
    ['vulkan', 'no usable Vulkan device'],
    ['vulkan', 'Vulkan device 1 (llvmpipe) cannot be used: needs Vulkan 1.2'],
    ['hip', 'hip: no device (gfx1100 build)'],
    ['hip', 'hip: device 1: this build’s kernels are for gfx1100, the device is gfx1030'],
    ['hip', 'libamdhip64.so.7: cannot open shared object file'],
  ] as const)('%s: "%s" is a device problem', (kind, message) => {
    expect(classifyCliFailure(kind, 1, message)).toMatchObject({ code: 'E_DEVICE' })
  })

  it('missing or non-bf16 model files are E_MODEL', () => {
    expect(classifyCliFailure('vulkan', 1, 'tokenizer: cannot open /m/tokenizer/tokenizer.json')).toMatchObject({ code: 'E_MODEL' })
    expect(classifyCliFailure('vulkan', 1, 'vulkan dit: x_embedder.weight is F16, expected BF16')).toMatchObject({ code: 'E_MODEL' })
  })

  it('anything else is E_ENGINE with the message; a signal or a silent failure says what happened', () => {
    expect(classifyCliFailure('vulkan', 1, 'vkQueueSubmit: VK_ERROR_DEVICE_LOST')).toEqual({ code: 'E_ENGINE', message: '生成失败：vkQueueSubmit: VK_ERROR_DEVICE_LOST' })
    expect(classifyCliFailure('hip', 1, null)).toEqual({ code: 'E_ENGINE', message: 'moss-infer-hip 退出码 1' })
    expect(classifyCliFailure('vulkan', null, null, 'SIGSEGV')).toEqual({ code: 'E_ENGINE', message: 'moss-infer-vulkan 意外退出（SIGSEGV）' })
    expect(classifyCliFailure('vulkan', 0, null)).toMatchObject({ code: 'E_NO_RESULT' })
  })
})

describe('parseHipDeviceList / pickHipIndex', () => {
  // hip_moss_infer_hip.cpp list_devices: `device %d: %s (%s), %.1f GiB` then `  kernels: …` or `  unusable: …`.
  const LIST = [
    'device 0: AMD Radeon RX 6800 (gfx1030), 16.0 GiB',
    "  unusable: this build's kernels are for gfx1100, the device is gfx1030",
    'device 1: AMD Radeon RX 7900 XTX (gfx1100), 24.0 GiB',
    '  kernels: gfx1100, wmma',
    'device 2: AMD Radeon RX 7900 XTX (gfx1100), 24.0 GiB',
    '  kernels: gfx1100, wmma',
    '',
  ].join('\n')

  it('reads every device with its HIP index, arch, memory and whether this build runs on it', () => {
    expect(parseHipDeviceList(LIST)).toEqual([
      { index: 0, name: 'AMD Radeon RX 6800', arch: 'gfx1030', totalGiB: 16, usable: false, reason: "this build's kernels are for gfx1100, the device is gfx1030" },
      { index: 1, name: 'AMD Radeon RX 7900 XTX', arch: 'gfx1100', totalGiB: 24, usable: true, kernels: 'gfx1100, wmma' },
      { index: 2, name: 'AMD Radeon RX 7900 XTX', arch: 'gfx1100', totalGiB: 24, usable: true, kernels: 'gfx1100, wmma' },
    ])
    expect(parseHipDeviceList('no HIP devices\n')).toEqual([])
    expect(parseHipDeviceList('device 0: Card (gfx1201), 16.0 GiB\r\n  kernels: gfx1201, wmma\r\n')).toMatchObject([{ index: 0, arch: 'gfx1201', usable: true }])
  })

  it('picks the usable device of the gfx target, the n-th of identical cards, nothing without a target', () => {
    const devices = parseHipDeviceList(LIST)
    expect(pickHipIndex(devices, 'gfx1100', 0)).toBe(1)
    expect(pickHipIndex(devices, 'gfx1100', 1)).toBe(2)
    // A card the list does not have is not clamped onto another one.
    expect(pickHipIndex(devices, 'gfx1100', 2)).toBeUndefined()
    expect(pickHipIndex(devices, 'gfx1100', -1)).toBeUndefined()
    expect(pickHipIndex(devices, 'gfx1030', 0)).toBeUndefined()
    expect(pickHipIndex(devices, 'gfx1201', 0)).toBeUndefined()
    expect(pickHipIndex(devices, undefined, 0)).toBeUndefined()
  })
})

describe('sameCliDevice', () => {
  it('matches the card the program chose with the GPU the job was assigned to', () => {
    expect(sameCliDevice({ name: 'NVIDIA GeForce RTX 4090 Laptop GPU' }, { name: 'NVIDIA GeForce RTX 4090 Laptop GPU' })).toBe(true)
    // Mesa adds its driver in parentheses; Intel adds (R)/(TM).
    expect(sameCliDevice({ name: 'AMD Radeon RX 7900 XTX (RADV NAVI31)' }, { name: 'AMD Radeon RX 7900 XTX' })).toBe(true)
    expect(sameCliDevice({ name: 'Intel(R) Arc(TM) A770 Graphics' }, { name: 'Intel Arc A770 Graphics' })).toBe(true)
    expect(sameCliDevice({ name: 'AMD Radeon RX 7900 XTX', arch: 'gfx1100' }, { name: 'AMD Radeon RX 7900 XTX (RADV NAVI31)', gfxTarget: 'gfx1100' })).toBe(true)
  })

  it('refuses another card, or the same name on another gfx target', () => {
    expect(sameCliDevice({ name: 'Intel(R) UHD Graphics 770' }, { name: 'NVIDIA GeForce RTX 4090' })).toBe(false)
    expect(sameCliDevice({ name: 'AMD Radeon Graphics' }, { name: 'AMD Radeon RX 7900 XTX' })).toBe(false)
    expect(sameCliDevice({ name: 'AMD Radeon RX 7900 XTX', arch: 'gfx1100' }, { name: 'AMD Radeon RX 7900 XTX', gfxTarget: 'gfx1201' })).toBe(false)
  })
})
