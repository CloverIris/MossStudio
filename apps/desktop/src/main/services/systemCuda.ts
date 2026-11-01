import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../lib/run'
import { DEFAULT_MOSSINFER_FLAVOUR, mossInferDriverCompatibilityError } from '../lib/engineAssets'

export interface SystemCudaStatus {
  supported: boolean
  gpu: string
  cublasLt: string[]
  flavours: Array<'cu12' | 'cu13'>
  driverVersion?: string
  driverCompatible?: boolean
  error?: string
}

function windowsCudaRoots(): string[] {
  const roots: string[] = []
  if (process.env['CUDA_PATH']) roots.push(process.env['CUDA_PATH'])
  const base = process.env['ProgramFiles'] ? join(process.env['ProgramFiles'], 'NVIDIA GPU Computing Toolkit', 'CUDA') : ''
  if (process.env['SystemRoot']) roots.push(join(process.env['SystemRoot'], 'System32'))
  if (base) {
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && /^v?1[23]\./i.test(entry.name)) roots.push(join(base, entry.name))
      }
    } catch { /* no CUDA toolkit */ }
  }
  return roots
}

export async function detectSystemCuda(): Promise<SystemCudaStatus> {
  if (process.platform === 'darwin') {
    return { supported: false, gpu: '', cublasLt: [], flavours: [], error: 'macOS 没有 NVIDIA CUDA / cuBLASLt' }
  }
  const gpu = await run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], { timeoutMs: 6000 })
  const driverVersion = gpu.stdout.split(/\r?\n/).map((row) => row.split(',').at(-1)?.trim()).find(Boolean)
  const libs: string[] = []
  if (process.platform === 'win32') {
    for (const root of windowsCudaRoots()) {
      const bin = join(root, 'bin')
      try {
        for (const name of readdirSync(bin)) if (/^cublasLt64_\d+\.dll$/i.test(name)) libs.push(join(bin, name))
      } catch { /* ignore */ }
    }
    for (const part of (process.env['PATH'] ?? '').split(';')) {
      try {
        for (const name of readdirSync(part)) if (/^cublasLt64_\d+\.dll$/i.test(name)) libs.push(join(part, name))
      } catch { /* ignore */ }
    }
  } else {
    const ld = await run('ldconfig', ['-p'], { timeoutMs: 6000 })
    for (const line of ld.stdout.split('\n')) {
      if (/libcublasLt\.so\.(12|13)\b/.test(line)) libs.push(line.trim())
    }
    if (!libs.length) {
      const find = await run('find', ['/usr/local/cuda', '/usr/lib', '/lib', '/opt/cuda/lib64', '/opt/cuda/targets', '-name', 'libcublasLt.so.*'], { timeoutMs: 6000 })
      for (const line of find.stdout.split('\n')) if (line.trim()) libs.push(line.trim())
    }
  }
  const flavours: Array<'cu12' | 'cu13'> = []
  if (libs.some((path) => /(?:so\.12|64_12\.dll|cuda-12|v12\.)/i.test(path))) flavours.push('cu12')
  if (libs.some((path) => /(?:so\.13|64_13\.dll|cuda-13|v13\.)/i.test(path))) flavours.push('cu13')
  const driverError = mossInferDriverCompatibilityError(DEFAULT_MOSSINFER_FLAVOUR, driverVersion)
  const driverCompatible = driverVersion
    ? driverError === null
    : undefined
  const hasCuda13Libraries = flavours.includes(DEFAULT_MOSSINFER_FLAVOUR)
  return {
    supported: gpu.code === 0 && hasCuda13Libraries && driverCompatible !== false,
    gpu: gpu.stdout.trim(),
    cublasLt: [...new Set(libs)].slice(0, 8),
    flavours,
    driverVersion,
    driverCompatible,
    error: gpu.code !== 0
      ? '未检测到 NVIDIA GPU / nvidia-smi'
      : driverError ?? (!hasCuda13Libraries
          ? flavours.includes('cu12')
            ? '系统只检测到 CUDA 12 cuBLASLt；MossInfer 默认需要 CUDA 13。可更新 CUDA，或让 MossStudio 随引擎准备 CUDA 13 库。'
            : '系统未找到 CUDA 13 cuBLASLt。可让 MossStudio 随引擎准备 CUDA 13 库。'
          : undefined),
  }
}
