import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  decodeEngineHello,
  judgeEngineSupport,
  matchEngineDevice,
  protocolCompatible,
  readEngineCompute,
} from '../apps/desktop/src/shared/engineProtocol.ts'

const gpu = { index: 0, name: 'NVIDIA GeForce RTX 5070 Laptop GPU' }
const helloFixture = {
  protocol_version: 2,
  server: 'fake-moss-server',
  version: '2.1.1',
  abi_version: 1,
  capabilities: { tiers: true, system_cuda: true },
  probe: {
    driver_cuda_version: 13040,
    runtime_cuda_version: 13040,
    driver_compatible: true,
    device_count: 1,
    supported_device_count: 1,
    build_flavour: 'cu13',
    recommended_flavour: 'cu13',
    cublaslt: { source: 'bundled', version: 130800, path: '/fake/libcublasLt.so.13', error: '' },
    devices: [{
      index: 0,
      name: gpu.name,
      compute_capability: '12.0',
      supported: true,
      unsupported_reason: '',
    }],
  },
}

test('解码字符串算力并保留原始 hello', () => {
  const hello = decodeEngineHello(helloFixture)
  assert.equal(hello.protocol, 2)
  assert.equal(hello.version, '2.1.1')
  assert.equal(hello.probe?.cublasLt?.source, 'bundled')
  assert.deepEqual(hello.probe?.devices[0]?.compute, { major: 12, minor: 0 })
  assert.equal(hello.raw, helloFixture)
  assert.equal(protocolCompatible(hello), true)
})

test('算力兼容 7.5 字符串、数值和分字段', () => {
  assert.deepEqual(readEngineCompute({ compute_capability: '7.5' }), { major: 7, minor: 5 })
  assert.deepEqual(readEngineCompute({ compute_capability: 12 }), { major: 12, minor: 0 })
  assert.deepEqual(readEngineCompute({ compute_major: 8, compute_minor: 9 }), { major: 8, minor: 9 })
  assert.equal(readEngineCompute({ compute_capability: 'not-a-number' }), null)
})

test('supported 缺失时解码为无结论并由统一判定拒绝', () => {
  const fixture = structuredClone(helloFixture)
  delete fixture.probe.devices[0].supported
  const hello = decodeEngineHello(fixture)
  assert.equal(hello.probe?.devices[0]?.supported, null)
  const verdict = judgeEngineSupport(hello, gpu)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason ?? '', /缺少 supported/)
})

test('probe 缺失时保留 hello 但兼容性判定失败', () => {
  const fixture = structuredClone(helloFixture)
  delete fixture.probe
  const hello = decodeEngineHello(fixture)
  assert.equal(hello.probe, undefined)
  assert.equal(judgeEngineSupport(hello, gpu).ok, false)
})

test('protocol 1 可解码但被协议门禁拒绝', () => {
  const hello = decodeEngineHello({ ...helloFixture, protocol_version: 1 })
  assert.equal(hello.protocol, 1)
  assert.equal(protocolCompatible(hello), false)
  assert.equal(judgeEngineSupport(hello, gpu).ok, false)
})

test('devices 非数组或设备项非对象时严格拒绝', () => {
  assert.throws(
    () => decodeEngineHello({ ...helloFixture, probe: { devices: {} } }),
    /devices 必须是数组/,
  )
  assert.throws(
    () => decodeEngineHello({ ...helloFixture, probe: { devices: [null] } }),
    /devices\[0\] 必须是对象/,
  )
})

test('设备先按序号和名称匹配，再回退到唯一名称', () => {
  const hello = decodeEngineHello(helloFixture)
  const devices = hello.probe?.devices ?? []
  assert.equal(matchEngineDevice(devices, gpu)?.index, 0)
  assert.equal(matchEngineDevice(devices, { index: 3, name: gpu.name })?.index, 0)
  assert.equal(matchEngineDevice(devices, { index: 3, name: 'Other GPU' }), undefined)
  assert.equal(matchEngineDevice(devices, { index: 0, name: 'Remapped GPU' }, { indexOnly: true })?.index, 0)
})

test('引擎 supported 是唯一权威，算力差异只产生警告', () => {
  const hello = decodeEngineHello(helloFixture)
  const verdict = judgeEngineSupport(hello, gpu, {
    expectedArchitecture: 'sm75',
    inventoryCapability: { major: 8, minor: 9 },
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.warnings.length, 2)
})

test('引擎明确不支持时采用引擎原因', () => {
  const fixture = structuredClone(helloFixture)
  fixture.probe.devices[0].supported = false
  fixture.probe.devices[0].unsupported_reason = 'no kernel image'
  const verdict = judgeEngineSupport(decodeEngineHello(fixture), gpu)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'no kernel image')
})

test('一次性 probe 真跑 fake moss-server 并严格解码', async () => {
  const protocolUrl = new URL('../apps/desktop/src/shared/engineProtocol.ts', import.meta.url).href
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@shared/engineProtocol') {
        return { url: protocolUrl, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
  const { probeEngine } = await import('../apps/desktop/src/main/lib/probeEngine.ts')
  const fakeServer = fileURLToPath(new URL('../tools/fake-moss-server.mjs', import.meta.url))
  const hello = await probeEngine(fakeServer, { timeoutMs: 5000 })
  assert.equal(hello.protocol, 2)
  assert.equal(hello.server, 'fake-moss-server')
  assert.equal(hello.probe?.devices.length, 1)
  assert.deepEqual(hello.probe?.devices[0]?.compute, { major: 8, minor: 9 })
})
