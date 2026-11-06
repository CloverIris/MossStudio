import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  decodeEngineHello,
  engineFeaturesOf,
  ENGINE_PROTOCOL_VERSION,
  type EngineDevice,
  type EngineHello,
  judgeEngineSupport,
  matchEngineDevice,
  protocolCompatible,
  readEngineCompute,
} from '@shared/engineProtocol'
import { probeEngine } from '@main/lib/probeEngine'

const gpu = { index: 0, name: 'NVIDIA GeForce RTX 5070 Laptop GPU' }

function helloFixture() {
  return {
    protocol_version: 2,
    server: 'fake-moss-server',
    version: '2.1.1',
    abi_version: 1,
    capabilities: { tiers: true, system_cuda: true } as Record<string, unknown>,
    probe: {
      driver_cuda_version: 13040,
      runtime_cuda_version: 13040,
      driver_compatible: true,
      device_count: 1,
      supported_device_count: 1,
      build_flavour: 'cu13',
      recommended_flavour: 'cu13',
      cublaslt: { source: 'bundled', version: 130800, path: '/fake/libcublasLt.so.13', error: '' },
      devices: [
        {
          index: 0,
          name: gpu.name,
          compute_capability: '12.0',
          supported: true as boolean | undefined,
          unsupported_reason: '',
        } as Record<string, unknown>,
      ],
    } as Record<string, unknown> & { devices: Array<Record<string, unknown>> },
  }
}

const device = (overrides: Partial<EngineDevice> = {}): EngineDevice => ({
  index: 0,
  name: 'GPU',
  supported: true,
  compute: { major: 8, minor: 9 },
  raw: {},
  ...overrides,
})

const helloWith = (devices: EngineDevice[], protocol = ENGINE_PROTOCOL_VERSION): EngineHello => ({
  protocol,
  capabilities: {},
  values: {},
  probe: { devices },
  raw: {},
})

describe('decodeEngineHello', () => {
  it('decodes string compute capability and keeps the raw hello', () => {
    const fixture = helloFixture()
    const hello = decodeEngineHello(fixture)
    expect(hello.protocol).toBe(2)
    expect(hello.server).toBe('fake-moss-server')
    expect(hello.version).toBe('2.1.1')
    expect(hello.abiVersion).toBe(1)
    expect(hello.capabilities).toEqual({ tiers: true, system_cuda: true })
    expect(hello.probe?.cublasLt).toEqual({
      source: 'bundled',
      version: 130800,
      path: '/fake/libcublasLt.so.13',
      error: '',
    })
    expect(hello.probe?.driverCudaVersion).toBe(13040)
    expect(hello.probe?.runtimeCudaVersion).toBe(13040)
    expect(hello.probe?.driverCompatible).toBe(true)
    expect(hello.probe?.deviceCount).toBe(1)
    expect(hello.probe?.supportedDeviceCount).toBe(1)
    expect(hello.probe?.buildFlavour).toBe('cu13')
    expect(hello.probe?.recommendedFlavour).toBe('cu13')
    expect(hello.probe?.devices[0]?.compute).toEqual({ major: 12, minor: 0 })
    expect(hello.probe?.devices[0]?.raw).toBe(fixture.probe.devices[0])
    expect(hello.raw).toBe(fixture)
    expect(protocolCompatible(hello)).toBe(true)
  })

  it('accepts the legacy `protocol` key and camelCase aliases', () => {
    const hello = decodeEngineHello({
      protocol: 2,
      abiVersion: 3,
      probe: {
        driverCudaVersion: 12080,
        runtimeCudaVersion: 12040,
        deviceCount: 2,
        supportedDeviceCount: 1,
        buildFlavour: 'cu12',
        recommendedFlavour: 'cu13',
        cublasLt: { source: 'system' },
        devices: [{ index: 1, name: 'X', unsupportedReason: 'old', pciBusId: '0000:01:00.0', totalMemoryBytes: 10, freeMemoryBytes: 5 }],
      },
    })
    expect(hello.protocol).toBe(2)
    expect(hello.abiVersion).toBe(3)
    expect(hello.probe).toMatchObject({
      driverCudaVersion: 12080,
      runtimeCudaVersion: 12040,
      deviceCount: 2,
      supportedDeviceCount: 1,
      buildFlavour: 'cu12',
      recommendedFlavour: 'cu13',
      cublasLt: { source: 'system' },
    })
    expect(hello.probe?.devices[0]).toMatchObject({
      index: 1,
      name: 'X',
      supported: null,
      unsupportedReason: 'old',
      pciBusId: '0000:01:00.0',
      totalMemoryBytes: 10,
      freeMemoryBytes: 5,
      compute: null,
    })
  })

  it('prefers protocol_version over protocol and falls back when it is null', () => {
    expect(decodeEngineHello({ protocol_version: 2, protocol: 1 }).protocol).toBe(2)
    expect(decodeEngineHello({ protocol_version: null, protocol: 1 }).protocol).toBe(1)
  })

  it('rejects a non-object or protocol-less hello', () => {
    for (const bad of [null, undefined, 'hello', 2, [], [{ protocol_version: 2 }]]) {
      expect(() => decodeEngineHello(bad)).toThrow('引擎 hello 必须是 JSON 对象')
    }
    for (const bad of [{}, { protocol_version: '2' }, { protocol_version: Number.NaN }, { protocol: Number.POSITIVE_INFINITY }]) {
      expect(() => decodeEngineHello(bad)).toThrow(/缺少有效的 protocol_version/)
    }
  })

  it('keeps only boolean capabilities', () => {
    const hello = decodeEngineHello({ protocol_version: 2, capabilities: { a: true, b: false, c: 'yes', d: 1, e: null } })
    expect(hello.capabilities).toEqual({ a: true, b: false })
    expect(decodeEngineHello({ protocol_version: 2, capabilities: ['a'] }).capabilities).toEqual({})
  })

  it('decodes missing supported as "no verdict" and the unified judge rejects it', () => {
    const fixture = helloFixture()
    delete fixture.probe.devices[0]!.supported
    const hello = decodeEngineHello(fixture)
    expect(hello.probe?.devices[0]?.supported).toBeNull()
    const verdict = judgeEngineSupport(hello, gpu)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/缺少 supported/)
    expect(verdict.device).toBe(hello.probe?.devices[0])
  })

  it('treats a non-boolean supported as no verdict', () => {
    const fixture = helloFixture()
    fixture.probe.devices[0]!.supported = 'true'
    expect(decodeEngineHello(fixture).probe?.devices[0]?.supported).toBeNull()
  })

  it('keeps the hello when probe is missing or null, but the judge fails', () => {
    for (const probe of [undefined, null]) {
      const fixture: Record<string, unknown> = { ...helloFixture(), probe }
      const hello = decodeEngineHello(fixture)
      expect(hello.probe).toBeUndefined()
      const verdict = judgeEngineSupport(hello, gpu)
      expect(verdict.ok).toBe(false)
      expect(verdict.reason).toMatch(/缺少 probe/)
    }
  })

  it('decodes protocol 1 but the protocol gate rejects it', () => {
    const hello = decodeEngineHello({ ...helloFixture(), protocol_version: 1 })
    expect(hello.protocol).toBe(1)
    expect(protocolCompatible(hello)).toBe(false)
    const verdict = judgeEngineSupport(hello, gpu)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe(`引擎协议为 1，需要 protocol ${ENGINE_PROTOCOL_VERSION}`)
  })

  it('strictly rejects malformed probe and device entries', () => {
    expect(() => decodeEngineHello({ ...helloFixture(), probe: { devices: {} } })).toThrow(/devices 必须是数组/)
    expect(() => decodeEngineHello({ ...helloFixture(), probe: { devices: [null] } })).toThrow(/devices\[0\] 必须是对象/)
    expect(() => decodeEngineHello({ ...helloFixture(), probe: { devices: [{}, 'x'] } })).toThrow(/devices\[1\] 必须是对象/)
    expect(() => decodeEngineHello({ ...helloFixture(), probe: [] })).toThrow(/probe 必须是对象/)
    expect(() => decodeEngineHello({ ...helloFixture(), probe: 'x' })).toThrow(/probe 必须是对象/)
  })

  it('defaults an absent device list to empty and drops ill-typed fields', () => {
    const hello = decodeEngineHello({
      protocol_version: 2,
      server: 5,
      version: null,
      abi_version: '1',
      probe: { driver_compatible: 'yes', message: 'ok', cublaslt: 'bundled' },
    })
    expect(hello.server).toBeUndefined()
    expect(hello.version).toBeUndefined()
    expect(hello.abiVersion).toBeUndefined()
    expect(hello.probe?.devices).toEqual([])
    expect(hello.probe?.driverCompatible).toBeUndefined()
    expect(hello.probe?.message).toBe('ok')
    expect(hello.probe?.cublasLt).toBeUndefined()
  })

  it('decodes a minimal device with safe defaults', () => {
    const hello = decodeEngineHello({ protocol_version: 2, probe: { devices: [{ index: 'zero', name: 7 }] } })
    expect(hello.probe?.devices[0]).toEqual({
      index: null,
      name: '',
      supported: null,
      unsupportedReason: undefined,
      compute: null,
      pciBusId: undefined,
      totalMemoryBytes: undefined,
      freeMemoryBytes: undefined,
      raw: { index: 'zero', name: 7 },
    })
  })
})

describe('readEngineCompute', () => {
  it('reads 7.5 from string, number and split fields', () => {
    expect(readEngineCompute({ compute_capability: '7.5' })).toEqual({ major: 7, minor: 5 })
    expect(readEngineCompute({ compute_capability: 12 })).toEqual({ major: 12, minor: 0 })
    expect(readEngineCompute({ compute_major: 8, compute_minor: 9 })).toEqual({ major: 8, minor: 9 })
    expect(readEngineCompute({ compute_capability: 'not-a-number' })).toBeNull()
  })

  it('reads a nested compute record and requires both parts', () => {
    expect(readEngineCompute({ compute: { major: 8, minor: 6 } })).toEqual({ major: 8, minor: 6 })
    expect(readEngineCompute({ compute: { major: 8 } })).toBeNull()
    // A malformed nested record wins over split fields: no guessing.
    expect(readEngineCompute({ compute: { major: 8 }, compute_major: 9, compute_minor: 0 })).toBeNull()
  })

  it('falls through when the nested compute value is not a record', () => {
    expect(readEngineCompute({ compute: null, compute_capability: '8.0' })).toEqual({ major: 8, minor: 0 })
    expect(readEngineCompute({ compute: '8.0', compute_major: 9, compute_minor: 0 })).toEqual({ major: 9, minor: 0 })
  })

  it('truncates split fields and defaults the minor', () => {
    expect(readEngineCompute({ compute_major: 8.7, compute_minor: 6.2 })).toEqual({ major: 8, minor: 6 })
    expect(readEngineCompute({ compute_major: 8 })).toEqual({ major: 8, minor: 0 })
    expect(readEngineCompute({ compute_major: 8, compute_minor: 'x' })).toEqual({ major: 8, minor: 0 })
  })

  it('ignores a zero or negative major and tries the next source', () => {
    expect(readEngineCompute({ compute_major: 0, compute_capability: '7.5' })).toEqual({ major: 7, minor: 5 })
    expect(readEngineCompute({ compute_major: -1 })).toBeNull()
    expect(readEngineCompute({ compute_capability: 0 })).toBeNull()
    expect(readEngineCompute({ compute_capability: -8 })).toBeNull()
    expect(readEngineCompute({ compute_capability: '0.0' })).toBeNull()
  })

  it('accepts padded and major-only strings, rejects malformed ones', () => {
    expect(readEngineCompute({ compute_capability: ' 8.6 ' })).toEqual({ major: 8, minor: 6 })
    expect(readEngineCompute({ compute_capability: '9' })).toEqual({ major: 9, minor: 0 })
    expect(readEngineCompute({ compute_capability: '10.10' })).toEqual({ major: 10, minor: 10 })
    for (const bad of ['8.', '.5', '8.6.1', 'sm_86', '', '8,6']) {
      expect(readEngineCompute({ compute_capability: bad })).toBeNull()
    }
  })

  it('returns null for non-record sources', () => {
    for (const bad of [null, undefined, '8.6', 8, [8, 6]]) {
      expect(readEngineCompute(bad)).toBeNull()
    }
    expect(readEngineCompute({})).toBeNull()
  })
})

describe('matchEngineDevice', () => {
  it('matches by index and name first, then falls back to a unique name', () => {
    const devices = decodeEngineHello(helloFixture()).probe?.devices ?? []
    expect(matchEngineDevice(devices, gpu)?.index).toBe(0)
    expect(matchEngineDevice(devices, { index: 3, name: gpu.name })?.index).toBe(0)
    expect(matchEngineDevice(devices, { index: 3, name: 'Other GPU' })).toBeUndefined()
    expect(matchEngineDevice(devices, { index: 0, name: 'Remapped GPU' }, { indexOnly: true })?.index).toBe(0)
  })

  it('compares names ignoring case and repeated whitespace', () => {
    const candidates = [device({ index: 5, name: '  NVIDIA   GeForce RTX 4090 ' })]
    expect(matchEngineDevice(candidates, { index: 0, name: 'nvidia geforce rtx 4090' })).toBe(candidates[0])
  })

  it('accepts an index match when either side has no name', () => {
    const unnamed = [device({ index: 1, name: '' })]
    expect(matchEngineDevice(unnamed, { index: 1, name: 'Anything' })).toBe(unnamed[0])
    const named = [device({ index: 1, name: 'GPU' })]
    expect(matchEngineDevice(named, { index: 1 })).toBe(named[0])
  })

  it('rejects an index match whose name disagrees', () => {
    expect(matchEngineDevice([device({ index: 0, name: 'A' })], { index: 0, name: 'B' })).toBeUndefined()
  })

  it('refuses to guess when names are ambiguous', () => {
    const twins = [device({ index: 0, name: 'Same' }), device({ index: 1, name: 'Same' })]
    expect(matchEngineDevice(twins, { index: 1, name: 'Same' })).toBe(twins[1])
    expect(matchEngineDevice(twins, { index: 7, name: 'Same' })).toBeUndefined()
    expect(matchEngineDevice(twins, { name: 'Same' })).toBeUndefined()
  })

  it('falls back to name when the index is duplicated', () => {
    const dupes = [device({ index: 0, name: '' }), device({ index: 0, name: 'B' })]
    expect(matchEngineDevice(dupes, { index: 0, name: 'B' })).toBe(dupes[1])
  })

  it('never matches without an index or a name', () => {
    expect(matchEngineDevice([device({ index: null, name: '' })], {})).toBeUndefined()
    expect(matchEngineDevice([device({ index: null, name: '' })], { name: '' })).toBeUndefined()
    expect(matchEngineDevice([], gpu)).toBeUndefined()
  })

  it('indexOnly ignores names and requires a unique index', () => {
    const candidates = [device({ index: 0, name: 'A' }), device({ index: 1, name: 'B' }), device({ index: 1, name: 'C' })]
    expect(matchEngineDevice(candidates, { index: 0, name: 'Z' }, { indexOnly: true })).toBe(candidates[0])
    expect(matchEngineDevice(candidates, { index: 1 }, { indexOnly: true })).toBeUndefined()
    expect(matchEngineDevice(candidates, { name: 'A' }, { indexOnly: true })).toBeUndefined()
    expect(matchEngineDevice([device({ index: null })], {}, { indexOnly: true })).toBeUndefined()
  })
})

describe('judgeEngineSupport', () => {
  it('treats engine supported as the only authority; capability gaps only warn', () => {
    const hello = decodeEngineHello(helloFixture())
    const verdict = judgeEngineSupport(hello, gpu, {
      expectedArchitecture: 'sm75',
      inventoryCapability: { major: 8, minor: 9 },
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.reason).toBeUndefined()
    expect(verdict.device).toBe(hello.probe?.devices[0])
    expect(verdict.warnings).toHaveLength(2)
    expect(verdict.warnings[0]).toContain('系统算力为 8.9，引擎报告为 12.0')
    expect(verdict.warnings[1]).toContain('SM75 构建')
  })

  it('uses the engine reason when it explicitly rejects the device', () => {
    const fixture = helloFixture()
    fixture.probe.devices[0]!.supported = false
    fixture.probe.devices[0]!.unsupported_reason = 'no kernel image'
    const verdict = judgeEngineSupport(decodeEngineHello(fixture), gpu)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('no kernel image')
    expect(verdict.warnings).toEqual([])
  })

  it('writes its own reason when the engine rejects without one', () => {
    const verdict = judgeEngineSupport(helloWith([device({ supported: false, unsupportedReason: '' })]), { index: 0, name: 'GPU' })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('引擎判定 GPU 不受此构建支持')
  })

  it('names the GPU, or a generic label, when no device matches', () => {
    expect(judgeEngineSupport(helloWith([]), { index: 0, name: '  RTX  ' }).reason).toBe(
      '引擎没有返回 RTX 的可匹配设备，未给出兼容性结论',
    )
    expect(judgeEngineSupport(helloWith([]), { index: 0, name: '   ' }).reason).toBe(
      '引擎没有返回 当前 GPU 的可匹配设备，未给出兼容性结论',
    )
  })

  it('checks the protocol before anything else', () => {
    const verdict = judgeEngineSupport(helloWith([device()], 3), { index: 0, name: 'GPU' })
    expect(verdict).toEqual({ ok: false, reason: `引擎协议为 3，需要 protocol ${ENGINE_PROTOCOL_VERSION}`, warnings: [] })
  })

  it('emits no warnings when capability matches expectations', () => {
    const sm75 = helloWith([device({ compute: { major: 7, minor: 5 } })])
    expect(
      judgeEngineSupport(sm75, { index: 0, name: 'GPU' }, {
        expectedArchitecture: 'sm75',
        inventoryCapability: { major: 7, minor: 5 },
      }).warnings,
    ).toEqual([])
    const ampere = helloWith([device({ compute: { major: 8, minor: 6 } })])
    expect(judgeEngineSupport(ampere, { index: 0, name: 'GPU' }, { expectedArchitecture: 'standard' }).warnings).toEqual([])
  })

  it('warns when a standard build reports a pre-Ampere capability', () => {
    const verdict = judgeEngineSupport(helloWith([device({ compute: { major: 7, minor: 5 } })]), { index: 0, name: 'GPU' }, {
      expectedArchitecture: 'standard',
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.warnings).toEqual(['标准构建报告 GPU 算力为 7.5；以引擎 supported 结论为准'])
  })

  it('skips capability warnings when the engine reports no capability', () => {
    const verdict = judgeEngineSupport(helloWith([device({ compute: null })]), { index: 0, name: 'GPU' }, {
      expectedArchitecture: 'sm75',
      inventoryCapability: { major: 8, minor: 9 },
    })
    expect(verdict).toMatchObject({ ok: true, warnings: [] })
  })

  it('ignores a null inventory capability and honours indexOnly', () => {
    const hello = helloWith([device({ index: 2, name: 'Engine Name' })])
    expect(judgeEngineSupport(hello, { index: 2, name: 'OS Name' }).ok).toBe(false)
    expect(judgeEngineSupport(hello, { index: 2, name: 'OS Name' }, { indexOnly: true, inventoryCapability: null })).toMatchObject({
      ok: true,
      warnings: [],
    })
  })
})

describe('probeEngine against the fake moss-server', () => {
  it('runs a one-shot probe and strictly decodes the hello', async () => {
    const fakeServer = fileURLToPath(new URL('../../../../tools/dev/fake-moss-server.mjs', import.meta.url))
    const hello = await probeEngine(fakeServer, { timeoutMs: 5000 })
    expect(hello.protocol).toBe(2)
    expect(protocolCompatible(hello)).toBe(true)
    expect(hello.server).toBe('fake-moss-server')
    expect(hello.probe?.devices).toHaveLength(1)
    expect(hello.probe?.devices[0]?.compute).toEqual({ major: 8, minor: 9 })
  })
})

describe('engineFeaturesOf', () => {
  /** moss-server 2.2's hello (main.cpp hello()): every capability, and the enum tables in `values`. */
  const hello22 = {
    protocol_version: 2,
    server: 'moss-server',
    version: '2.2.0',
    capabilities: {
      preview: true, comfyui_models: false, model_files: true, lora: true, tiers: true, samplers: true,
      image_input: true, hires: true, distill: true, system_cuda: true, control: true, accel: true,
      preload: true, release: true, certificate_dirs: false, te_host_pin: true, progress_fraction: true,
      inspect: true, references: true, check: true, components: true,
    },
    values: {
      sampler: ['euler', 'ab2', 'euler_ancestral', 'heun', 'dpmpp_2m', 'dpmpp_2m_sde', 'er_sde', 'res_multistep', 'dataspace'],
      scheduler: ['moss', 'simple', 'normal', 'karras', 'exponential', 'beta', 'sgm_uniform'],
      resize: ['crop', 'fit', 'stretch'],
      mask_encoding: ['u8', 'binary01'],
      step_cache: ['off', 'fbcache'],
      tier: ['reference', 'high', 'turbo'],
    },
  }

  it('reads the generation capabilities and the enum names of a 2.2 engine', () => {
    const features = engineFeaturesOf(decodeEngineHello(hello22))
    expect(features).toEqual({
      preview: true, imageInput: true, control: true, references: true, hires: true, samplers: true, lora: true,
      values: hello22.values,
    })
  })

  it('treats an engine without these capabilities (older than 2.2) as supporting none of them', () => {
    const features = engineFeaturesOf(decodeEngineHello({ protocol_version: 2, version: '2.1.1', capabilities: { tiers: true, lora: true } }))
    expect(features).toEqual({ preview: false, imageInput: false, control: false, references: false, hires: false, samplers: false, lora: true, values: {} })
  })

  it('counts only a literal true, and keeps only string names', () => {
    const features = engineFeaturesOf(decodeEngineHello({
      protocol_version: 2,
      capabilities: { preview: 'yes', image_input: 1, control: false },
      values: { sampler: ['euler', 3, null, 'heun'], scheduler: 'karras', resize: [] },
    }))
    expect(features.preview).toBe(false)
    expect(features.imageInput).toBe(false)
    expect(features.control).toBe(false)
    expect(features.values).toEqual({ sampler: ['euler', 'heun'], resize: [] })
  })

  it('returns a copy of the names, not the hello\'s own arrays', () => {
    const hello = decodeEngineHello(hello22)
    engineFeaturesOf(hello).values['sampler']!.push('mine')
    expect(hello.values['sampler']).not.toContain('mine')
  })
})
