import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sshHostFixture } from '@test/mocks/backend/fixtures'

const response = { code: 0, stdout: '', stderr: '', timedOut: false }
const sshExec = vi.fn(async (..._args: unknown[]) => response)
vi.mock('@main/services/ssh', () => ({ posixQuote: (value: string) => `'${value}'`, sshExec: (...args: unknown[]) => sshExec(...args) }))

const { probeRemoteCuda } = await import('@main/services/remoteCuda')
const b64 = (text: string) => Buffer.from(text).toString('base64')
const put = (key: string, value: string) => `${key}\t${b64(value)}`
const lib = (candidate: string, real: string, status: string) => `LIB\t${b64(candidate)}\t${b64(real)}\t${status}`
const host = sshHostFixture()

function reply(lines: string[], patch: Partial<typeof response> = {}) {
  Object.assign(response, { code: 0, stdout: lines.join('\n'), stderr: '', timedOut: false, ...patch })
}
const base = [put('ROOT', '/home/moss/.mossstudio/engine'), put('ENGINE', 'yes'), put('METADATA', '{"version":"v2.1.1"}')]

beforeEach(() => sshExec.mockClear())

describe('probeRemoteCuda', () => {
  it('gives nvidia-smi 15 s and reports a timeout instead of an empty GPU list', async () => {
    reply([...base, put('GPU_CSV', ''), put('SMI_EXIT', '124')])
    const status = await probeRemoteCuda(host)
    expect(status.cuda).toMatchObject({ nvidiaSmiTimedOut: true, computeCapabilities: [] })
    expect(sshExec.mock.calls[0]![3]).toContain('timeout 15 nvidia-smi')
    reply([...base, put('GPU_CSV', 'RTX 4090, 24564 MiB, 590.48.01, 8.9'), put('SMI_EXIT', '0')])
    expect((await probeRemoteCuda(host)).cuda!.nvidiaSmiTimedOut).toBeUndefined()
  })

  it('reads every display device from DRM and the nvidia-smi names, for the engine chooser', async () => {
    reply([...base,
      put('GPU_CSV', 'Tesla V100-PCIE-32GB, 32768 MiB, 550.163.01, 7.0'),
      put('DRM', '0x1a03:0x2000\n0x10de:0x1db6\n0x1002:0x744c\n'),
    ])
    const status = await probeRemoteCuda(host)
    expect(status.cuda).toMatchObject({ gpuNames: ['Tesla V100-PCIE-32GB'], pciIds: ['1a03:2000', '10de:1db6', '1002:744c'], standardArchitectureSupported: false })
    expect(status.cuda!.gpuReason).toContain('SM70 引擎包')
    expect(sshExec.mock.calls[0]![3]).toContain('/sys/class/drm/card[0-9]/device')
  })

  it('decodes engine state, GPU rows, driver and passing libraries', async () => {
    reply([...base,
      put('DRIVER', 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  580.82.07  Wed'),
      put('GPU', 'NVIDIA A100'),
      put('GPU_CSV', 'NVIDIA A100, 81920 MiB, 580.82.07, 8.0\nNVIDIA A100, 81920 MiB, 580.82.07, 8.0'),
      lib('/usr/lib/libcublasLt.so.13', '/usr/lib/libcublasLt.so.13.0.2', 'passed'),
      lib('/usr/lib/libcublasLt.so.12', '/usr/lib/libcublasLt.so.12.4.5', 'failed'),
    ])
    const status = await probeRemoteCuda(host)
    expect(status).toMatchObject({ online: true, available: true, root: '/home/moss/.mossstudio/engine', path: '/home/moss/.mossstudio/engine/bin/moss-server', version: 'v2.1.1' })
    expect(status.gpu).toBe('NVIDIA A100, 81920 MiB\nNVIDIA A100, 81920 MiB')
    expect(status.cuda).toMatchObject({
      driverVersion: '580.82.07', computeCapabilities: ['8.0', '8.0'], flavours: ['cu13'], foundFlavours: ['cu13', 'cu12'],
      recommendedFlavour: 'cu13', recommendedVariant: 'system-cuda', standardArchitectureSupported: true, error: undefined,
    })
    expect(status.cuda!.libraries[0]).toEqual({ path: '/usr/lib/libcublasLt.so.13.0.2', major: 13, versionText: '13.0.2', dependencyCheck: 'passed', error: undefined })
    expect(sshExec).toHaveBeenCalledWith(host, 'bash -s', 30_000, expect.stringContaining("root='~/.mossstudio/engine'"))
  })

  it('flags a library whose real file does not match its link major', async () => {
    reply([...base, put('DRIVER', ''), lib('/x/libcublasLt.so.13', '/x/libcublasLt.so.12.1', 'passed')])
    const status = await probeRemoteCuda(host)
    expect(status.cuda!.libraries[0]).toMatchObject({ major: 13, dependencyCheck: 'failed', error: '库文件主版本与链接名称不一致' })
    expect(status.cuda!.flavours).toEqual([])
    expect(status.cuda!.error).toMatch(/依赖检查未通过/)
  })

  it('recommends bundled CUDA when the driver allows cu13 but no system library passed', async () => {
    reply([...base, put('DRIVER', 'Kernel Module  590.10.01 '), put('GPU_CSV', 'RTX 2080, 8192 MiB, , 7.5')])
    const status = await probeRemoteCuda(host)
    expect(status.cuda).toMatchObject({ driverVersion: '590.10.01', recommendedFlavour: 'cu13', recommendedVariant: 'bundled', standardArchitectureSupported: false, error: '未发现系统 cuBLASLt 12/13。' })
    expect(status.cuda!.gpuReason).toMatch(/SM75/)
  })

  it('falls back to cu12 for an R525–R579 driver and to nothing for older drivers', async () => {
    reply([...base, put('GPU_CSV', 'T4, 15360 MiB, 535.104.05, 7.5'), lib('/l/libcublasLt.so.12', '/l/libcublasLt.so.12', 'passed')])
    expect((await probeRemoteCuda(host)).cuda).toMatchObject({ recommendedFlavour: 'cu12', recommendedVariant: 'system-cuda' })
    reply([...base, put('GPU_CSV', 'K80, 1 MiB, 470.1.1, 3.7')])
    expect((await probeRemoteCuda(host)).cuda).toMatchObject({ recommendedFlavour: undefined, recommendedVariant: undefined })
  })

  it('ignores malformed lines and unknown dependency states', async () => {
    reply([...base, 'garbage', lib('/l/libcublasLt.so.11', '/l/x', 'passed'), lib('/l/libcublasLt.so.13', '/l/x', 'maybe')])
    expect((await probeRemoteCuda(host)).cuda!.libraries).toEqual([])
  })

  it('skips the CUDA scan when asked', async () => {
    reply(base)
    const status = await probeRemoteCuda(host, false)
    expect(status.cuda).toBeUndefined()
    expect(sshExec.mock.calls[0]![3]).not.toContain('GPU_CSV')
  })

  it('reports offline hosts, failed scripts and bad metadata', async () => {
    reply([], { code: 255, stderr: 'Connection refused' })
    expect(await probeRemoteCuda(host)).toMatchObject({ online: false, available: false, error: 'Connection refused', root: '~/.mossstudio/engine' })
    reply([], { code: 127, stderr: '远端检测缺少系统命令：base64' })
    expect(await probeRemoteCuda(host)).toMatchObject({ online: true, available: false, error: '远端检测缺少系统命令：base64' })
    reply([put('ROOT', '/r'), put('ENGINE', 'no'), put('METADATA', '{bad')])
    const status = await probeRemoteCuda(host, false)
    expect(status.available).toBe(false)
    expect('version' in status || 'error' in status).toBe(false)
  })
})
