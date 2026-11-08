import { describe, expect, it } from 'vitest'
import type { EngineMachineGpu } from '@shared/engineChoice'
import {
  MIN_GPU_MEMORY_BYTES,
  MODEL_DOWNLOAD_HEADROOM_BYTES,
  RESERVED_SYSTEM_MEMORY_BYTES,
  SLOW_GPU_MEMORY_BYTES,
  SLOW_SYSTEM_MEMORY_BYTES,
  dedicatedGpuMemory,
  freeSpaceNeeded,
  gpuMemoryTooSmall,
  memoryGb,
  missingDownloadBytes,
  modelPartSpaceNeeded,
  shortDisks,
  slowReason,
  tooLittleGpuMemory,
} from '@shared/machineFit'
import { RELEASE_220, enginePlanFor, machineFixture } from '@test/mocks/backend/machines'

const GiB = 1024 ** 3
const MiB = 1024 ** 2

const plan = (gpus: EngineMachineGpu[]) =>
  enginePlanFor({ ...machineFixture('nvidia'), gpus }, RELEASE_220, { engineDeviceOverrides: {}, mossInferChannel: 'stable' }, [])

const card = (id: string, memoryBytes: number | undefined, patch: Partial<EngineMachineGpu> = {}): EngineMachineGpu => ({
  id,
  name: `Card ${id}`,
  vendor: 'nvidia',
  computeCapability: { major: 8, minor: 6 },
  driverVersion: '581.42',
  vulkan: { index: 0, usable: true, discrete: true, kernels: 'coop' },
  ...(memoryBytes === undefined ? {} : { memoryBytes }),
  ...patch,
})

describe('the thresholds', () => {
  it('are 4 GB to run at all, 8 GB of GPU memory and 16 GB of system memory to run at speed', () => {
    expect([MIN_GPU_MEMORY_BYTES, SLOW_GPU_MEMORY_BYTES, SLOW_SYSTEM_MEMORY_BYTES].map((value) => value / GiB)).toEqual([4, 8, 16])
  })

  it('read memory in whole GB, as people know it', () => {
    expect(memoryGb(15.6 * GiB)).toBe(16)
    expect(memoryGb(8192 * MiB)).toBe(8)
    expect(memoryGb(7.7 * GiB)).toBe(8)
    expect(memoryGb(3.4 * GiB)).toBe(3)
  })
})

describe('dedicatedGpuMemory', () => {
  it('is the card memory nvidia-smi reports', () => {
    expect(dedicatedGpuMemory(card('a', 6 * GiB))).toBe(6 * GiB)
  })

  it('is unknown without a number', () => {
    expect(dedicatedGpuMemory(card('a', undefined))).toBeNull()
    expect(dedicatedGpuMemory(card('a', 0))).toBeNull()
  })

  it('never counts an integrated GPU: its memory is a share of system RAM', () => {
    expect(dedicatedGpuMemory(card('a', 2 * GiB, { vulkan: { index: 0, usable: true, discrete: false } }))).toBeNull()
  })
})

describe('tooLittleGpuMemory', () => {
  it('blocks a card with 2 GB, and one with 3 GB', () => {
    expect(tooLittleGpuMemory(plan([card('a', 2 * GiB)]))).toEqual({ name: 'Card a', bytes: 2 * GiB })
    expect(tooLittleGpuMemory(plan([card('a', 3 * GiB)]))).toEqual({ name: 'Card a', bytes: 3 * GiB })
  })

  it('lets a card with 4 GB run, and one that reports a little under it', () => {
    expect(tooLittleGpuMemory(plan([card('a', 4 * GiB)]))).toBeNull()
    expect(tooLittleGpuMemory(plan([card('a', 4095 * MiB)]))).toBeNull()
  })

  it('never blocks when the memory is not known', () => {
    expect(tooLittleGpuMemory(plan([card('a', undefined)]))).toBeNull()
  })

  it('never blocks an integrated GPU on its shared memory', () => {
    const integrated = card('a', 2 * GiB, {
      vendor: 'intel',
      computeCapability: undefined,
      vulkan: { index: 0, usable: true, discrete: false, kernels: 'plain' },
    })
    expect(tooLittleGpuMemory(plan([integrated]))).toBeNull()
  })

  it('names the biggest card when every card is too small', () => {
    expect(tooLittleGpuMemory(plan([card('a', 2 * GiB), card('b', 3 * GiB)]))).toEqual({ name: 'Card b', bytes: 3 * GiB })
  })

  it('does not block when one card is big enough, or of unknown size', () => {
    expect(tooLittleGpuMemory(plan([card('a', 2 * GiB), card('b', 12 * GiB)]))).toBeNull()
    expect(tooLittleGpuMemory(plan([card('a', 2 * GiB), card('b', undefined)]))).toBeNull()
  })

  it('only looks at GPUs that run an engine', () => {
    const unusable = card('b', 24 * GiB, {
      computeCapability: { major: 6, minor: 1 },
      vulkan: { index: 1, usable: false, discrete: true, reason: 'no shaderInt64' },
    })
    expect(tooLittleGpuMemory(plan([card('a', 2 * GiB), unusable]))).toEqual({ name: 'Card a', bytes: 2 * GiB })
  })
})

describe('slowReason', () => {
  const plenty = { compatibility: false, gpuMemoryBytes: 24 * GiB, systemMemoryBytes: 32 * GiB }

  it('is null on a computer that runs at speed', () => {
    expect(slowReason(plenty)).toBeNull()
  })

  it('puts 兼容模式 first, then GPU memory, then system memory', () => {
    const everything = { compatibility: true, gpuMemoryBytes: 6 * GiB, systemMemoryBytes: 8 * GiB }
    expect(slowReason(everything)).toEqual({ kind: 'compatibility' })
    expect(slowReason({ ...everything, compatibility: false })).toEqual({ kind: 'gpuMemory', bytes: 6 * GiB })
    expect(slowReason({ ...everything, compatibility: false, gpuMemoryBytes: 8 * GiB })).toEqual({
      kind: 'systemMemory',
      bytes: 8 * GiB,
    })
  })

  it('warns under 8 GB of GPU memory, not at 8 GB', () => {
    expect(slowReason({ ...plenty, gpuMemoryBytes: 6 * GiB })).toEqual({ kind: 'gpuMemory', bytes: 6 * GiB })
    expect(slowReason({ ...plenty, gpuMemoryBytes: 8192 * MiB })).toBeNull()
  })

  it('allows for memory an integrated GPU reserves: a 16 GB laptop may report 13.5 GiB', () => {
    expect(SLOW_SYSTEM_MEMORY_BYTES - RESERVED_SYSTEM_MEMORY_BYTES).toBe(13.5 * GiB)
    expect(slowReason({ ...plenty, systemMemoryBytes: 13.5 * GiB })).toBeNull()
    expect(slowReason({ ...plenty, systemMemoryBytes: 13.4 * GiB })).toEqual({ kind: 'systemMemory', bytes: 13.4 * GiB })
  })

  it('warns under 16 GB of system memory, not on a 16 GB computer that reports 15.6 GiB', () => {
    expect(slowReason({ ...plenty, systemMemoryBytes: 8 * GiB })).toEqual({ kind: 'systemMemory', bytes: 8 * GiB })
    expect(slowReason({ ...plenty, systemMemoryBytes: 15.6 * GiB })).toBeNull()
  })

  it('only warns on very little system memory: it never blocks', () => {
    expect(slowReason({ ...plenty, systemMemoryBytes: 4 * GiB })).toEqual({ kind: 'systemMemory', bytes: 4 * GiB })
  })

  it('says nothing about memory that is not known', () => {
    expect(slowReason({ compatibility: false, gpuMemoryBytes: null, systemMemoryBytes: undefined })).toBeNull()
  })
})

describe('gpuMemoryTooSmall', () => {
  it('is under 4 GB of known memory only', () => {
    expect(gpuMemoryTooSmall(2 * GiB)).toBe(true)
    expect(gpuMemoryTooSmall(4095 * MiB)).toBe(false)
    expect(gpuMemoryTooSmall(undefined)).toBe(false)
    expect(gpuMemoryTooSmall(null)).toBe(false)
  })
})

describe('room for a download', () => {
  it('asks a tenth more than the download, like the check on start', () => {
    expect(freeSpaceNeeded(10 * GiB)).toBeCloseTo(11 * GiB)
  })

  it('a model part adds its headroom first, and asks for nothing when nothing is missing', () => {
    expect(MODEL_DOWNLOAD_HEADROOM_BYTES).toBe(GiB)
    expect(modelPartSpaceNeeded(9 * GiB)).toBeCloseTo(11 * GiB)
    expect(modelPartSpaceNeeded(0)).toBe(0)
  })

  it('counts what is missing: complete files are free, a .part keeps its bytes, a wrong-size blob is not complete', () => {
    expect(
      missingDownloadBytes([
        { size: 4000, blobBytes: 4000, partBytes: -1 },
        { size: 3000, blobBytes: -1, partBytes: 1000 },
        { size: 500, blobBytes: -1, partBytes: -1 },
        { size: 800, blobBytes: 10, partBytes: 300 },
        // A .part larger than the file (a changed upstream file) never counts below zero.
        { size: 100, blobBytes: -1, partBytes: 900 },
      ]),
    ).toBe(2000 + 500 + 500)
  })

  it('reports each disk that cannot hold its parts together, and leaves unknown ones alone', () => {
    const disks = [
      { path: 'a', freeBytes: 20 * GiB, missingBytes: [8 * GiB, 9 * GiB] },
      { path: 'b', freeBytes: 20 * GiB, missingBytes: [8 * GiB] },
      { path: 'c', freeBytes: null, missingBytes: [80 * GiB] },
      { path: 'd', freeBytes: 0, missingBytes: [] },
    ]
    expect(shortDisks(disks)).toEqual([{ ...disks[0], neededBytes: modelPartSpaceNeeded(8 * GiB) + modelPartSpaceNeeded(9 * GiB) }])
  })
})
