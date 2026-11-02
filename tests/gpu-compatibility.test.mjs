import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const protocolUrl = new URL('../apps/desktop/src/shared/engineProtocol.ts', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './engineProtocol' && context.parentURL?.endsWith('/gpuCompatibility.ts')) {
      return { url: protocolUrl, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
const { mapEngineGpuProbe } = await import('../apps/desktop/src/shared/gpuCompatibility.ts')

const inventory = [
  { uuid: 'a', index: 0, name: 'GPU A', driverVersion: '581.15' },
  { uuid: 'b', index: 1, name: 'GPU B', driverVersion: '560.10' },
  { uuid: 'c', index: 2, name: 'GPU C' },
]

test('引擎 probe 按序号和名称映射支持与不支持设备', () => {
  const result = mapEngineGpuProbe(
    inventory,
    [
      { index: 0, name: 'GPU A', supported: true },
      { index: 1, name: 'GPU B', supported: false, unsupportedReason: 'unsupported SM' },
    ],
    'moss-server',
    '2.1.1',
    '2026-11-01T00:00:00.000Z',
  )
  assert.deepEqual(result.devices.map(({ uuid, status }) => [uuid, status]), [
    ['a', 'supported'],
    ['b', 'unsupported'],
    ['c', 'unknown'],
  ])
  assert.equal(result.devices[1].reason, 'unsupported SM')
  assert.equal(result.engineVersion, '2.1.1')
})

test('重名 GPU 不做名称猜测匹配', () => {
  const result = mapEngineGpuProbe(
    [
      { uuid: 'a', index: 0, name: 'Same GPU' },
      { uuid: 'b', index: 1, name: 'Same GPU' },
    ],
    [{ name: 'Same GPU', index: null, supported: true }],
    'moss-server',
  )
  assert.deepEqual(result.devices.map((device) => device.status), ['unknown', 'unknown'])
})

test('驱动初始化错误补充 CUDA 13 驱动说明', () => {
  const result = mapEngineGpuProbe(
    [inventory[1]],
    [{
      index: 1,
      name: 'GPU B',
      supported: false,
      unsupportedReason: 'no Nvidia driver is loader',
    }],
    'moss-server',
  )
  assert.match(result.devices[0].reason ?? '', /560\.10/)
  assert.match(result.devices[0].reason ?? '', /R580/)
  assert.doesNotMatch(result.devices[0].reason ?? '', /CUDA 12/)
})
