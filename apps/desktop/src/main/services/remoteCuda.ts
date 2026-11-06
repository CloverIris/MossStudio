import { posix } from 'node:path'
import type { RemoteCudaProbe, RemoteEngineInfo, TrainingHost } from '@shared/types'
import { posixQuote, sshExec } from './ssh'
import { drmPciId } from '../lib/amdGpus'
import type { EngineMachine, EngineMachineGpu } from '@shared/engineChoice'

/**
 * The host as the engine chooser sees it: one NVIDIA GPU per nvidia-smi row
 * (compute capability, driver) and the non-NVIDIA display devices from DRM.
 * Hosts only run moss-server, so the chooser is asked for CUDA builds only.
 */
export function remoteMachine(info: Pick<RemoteEngineInfo, 'cuda' | 'gpu'>): EngineMachine {
  const cuda = info.cuda
  const gpus: EngineMachineGpu[] = []
  const names = cuda?.gpuNames ?? []
  const capabilities = cuda?.computeCapabilities ?? []
  const count = Math.max(names.length, capabilities.length)
  for (let index = 0; index < count; index += 1) {
    const match = /^(\d+)\.(\d+)$/.exec(capabilities[index] ?? '')
    gpus.push({
      id: `remote-nvidia-${index}`,
      name: names[index] || `NVIDIA GPU ${index}`,
      vendor: 'nvidia',
      ...(match ? { computeCapability: { major: Number(match[1]), minor: Number(match[2]) } } : {}),
      ...(cuda?.driverVersion ? { driverVersion: cuda.driverVersion } : {}),
    })
  }
  const ordinals = new Map<string, number>()
  for (const pciId of cuda?.pciIds ?? []) {
    if (pciId.startsWith('10de:')) continue
    const ordinal = ordinals.get(pciId) ?? 0
    ordinals.set(pciId, ordinal + 1)
    const vendor = pciId.startsWith('1002:') ? 'amd' : pciId.startsWith('8086:') ? 'intel' : 'other'
    gpus.push({
      id: `remote-${pciId}-${ordinal}`,
      name: vendor === 'amd' ? 'AMD 显卡' : vendor === 'intel' ? 'Intel 显卡' : '显卡',
      vendor,
      pciId,
    })
  }
  return { os: 'linux', gpus, systemCuda: cuda?.flavours ?? [], rocm7: false, vulkanProbed: true }
}

function driverAllows(version: string | undefined, flavour: 'cu12' | 'cu13'): boolean {
  const parts = version?.split('.').map(Number)
  if (!parts?.length || parts.some((part) => !Number.isFinite(part))) return false
  const minimum = flavour === 'cu13' ? [580, 65, 6] : [525, 60, 13]
  for (let index = 0; index < minimum.length; index++) {
    if ((parts[index] ?? 0) !== minimum[index]) return (parts[index] ?? 0) > minimum[index]!
  }
  return true
}

export async function probeRemoteCuda(host: TrainingHost, scanCuda = true): Promise<RemoteEngineInfo> {
  const started = Date.now()
  const configuredRoot = host.engineRoot?.trim() || '~/.mossstudio/engine'
  const script = `
for tool in bash base64 tr readlink head cat awk cut; do
  command -v "$tool" >/dev/null 2>&1 || { echo "远端检测缺少系统命令：$tool" >&2; exit 127; }
done
put() { printf '%s\\t' "$1"; printf '%s' "$2" | base64 | tr -d '\\n'; printf '\\n'; }
root=${posixQuote(configuredRoot)}
case "$root" in "~/"*) root="$HOME/$(printf '%s' "$root" | cut -c3-)";; "~") root="$HOME";; esac
root=$(readlink -m "$root")
put ROOT "$root"
if test -x "$root/bin/moss-server"; then put ENGINE yes; else put ENGINE no; fi
put METADATA "$(head -c 65536 "$root/.mossstudio-engine.json" 2>/dev/null || true)"
${
  scanCuda
    ? `
put DRIVER "$(cat /proc/driver/nvidia/version 2>/dev/null || true)"
gpu=$(for info in /proc/driver/nvidia/gpus/*/information; do
  test -r "$info" && awk '/^Model:/ {sub(/^Model:[[:space:]]*/, "");print}' "$info"
done)
put GPU "$gpu"
put DRM "$(for card in /sys/class/drm/card[0-9]/device /sys/class/drm/card[0-9][0-9]/device; do test -r "$card/vendor" && printf '%s:%s\\n' "$(cat "$card/vendor")" "$(cat "$card/device" 2>/dev/null)"; done)"
if command -v nvidia-smi >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
  # A busy or just-woken GPU can take seconds to answer; 124 = timed out.
  csv=$(timeout 15 nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader 2>/dev/null); smi=$?
  put GPU_CSV "$csv"
  put SMI_EXIT "$smi"
fi
seen='|'; count=0
library() {
  candidate="$1"; test -f "$candidate" || return 0
  real=$(readlink -f "$candidate") || return 0
  case "$real" in "$root"|"$root"/*) return 0;; esac
  case "$seen" in *"|$real|"*) return 0;; esac
  seen="$seen$real|"; count=$((count+1)); test "$count" -le 4 || return 0
  status=unavailable
  if command -v ldd >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
    dependencies=$(timeout 1 ldd "$real" 2>&1); code=$?
    case "$dependencies" in *"not found"*) status=failed;; *) if test "$code" -eq 0; then status=passed; else status=failed; fi;; esac
  fi
  printf 'LIB\\t'; printf '%s' "$candidate" | base64 | tr -d '\\n'
  printf '\\t'; printf '%s' "$real" | base64 | tr -d '\\n'; printf '\\t%s\\n' "$status"
}
loader=$(command -v ldconfig || true)
test -n "$loader" || loader=/usr/sbin/ldconfig
test -x "$loader" || loader=/sbin/ldconfig
while IFS= read -r path; do library "$path"; done < <("$loader" -p 2>/dev/null | awk '/libcublasLt[.]so[.](12|13)( |$)/ {print $NF}')
for cuda in "$CUDA_PATH" "$CUDA_HOME" /usr/local/cuda /usr/local/cuda-12 /usr/local/cuda-13 /usr/local/cuda-12.* /usr/local/cuda-13.* /opt/cuda; do
  case "$cuda" in /*) ;; *) continue;; esac
  for directory in "$cuda/lib64" "$cuda/targets/x86_64-linux/lib"; do
    for major in 12 13; do library "$directory/libcublasLt.so.$major"; done
  done
done
while IFS= read -r directory; do
  case "$directory" in /*) ;; *) continue;; esac
  for major in 12 13; do library "$directory/libcublasLt.so.$major"; done
done < <({ printf '%s' "$LD_LIBRARY_PATH" | tr ':' '\\n' | head -n 12; printf '\\n/usr/lib/x86_64-linux-gnu\\n/usr/lib64\\n/usr/lib\\n'; })
`
    : ''
}
true`
  // nvidia-smi alone may take up to 15 s.
  const response = await sshExec(host, 'bash -s', scanCuda ? 30_000 : 12_000, script)
  const checkedAt = new Date().toISOString()
  const fields = new Map<string, string>()
  const libraries: RemoteCudaProbe['libraries'] = []
  const decode = (value: string | undefined): string => Buffer.from(value ?? '', 'base64').toString('utf8')
  for (const line of response.stdout.split(/\r?\n/)) {
    const [key, value, target, dependencyCheck] = line.split('\t')
    if (key === 'LIB') {
      const path = decode(target)
      const major = /libcublasLt\.so\.(12|13)(?:\.|$)/.exec(decode(value))?.[1]
      if (!major || !['passed', 'failed', 'unavailable'].includes(dependencyCheck ?? '')) continue
      const versionText = /libcublasLt\.so\.(\d+(?:\.\d+)*)$/.exec(path)?.[1]
      const matchesMajor = !versionText || versionText.split('.')[0] === major
      libraries.push({
        path,
        major: Number(major) as 12 | 13,
        versionText,
        dependencyCheck: matchesMajor ? (dependencyCheck as 'passed' | 'failed' | 'unavailable') : 'failed',
        error: matchesMajor ? undefined : '库文件主版本与链接名称不一致',
      })
    } else if (key && value !== undefined) fields.set(key, decode(value))
  }
  const root = posix.normalize(fields.get('ROOT') || configuredRoot)
  const status: RemoteEngineInfo = {
    online: response.code >= 0 && response.code !== 255 && !response.timedOut,
    available: response.code === 0 && fields.get('ENGINE') === 'yes',
    root,
    path: `${root}/bin/moss-server`,
    gpu: fields.get('GPU') ?? '',
    checkedAt,
  }
  if (response.code !== 0 || !fields.has('ROOT')) {
    status.error = (response.stderr || response.stdout || '远端检测失败').trim().slice(-1200)
    return status
  }
  try {
    const record = JSON.parse(fields.get('METADATA') || '{}') as { version?: unknown }
    if (typeof record?.version === 'string') status.version = record.version
  } catch {
    /* Custom/old engines need no metadata file. */
  }
  if (scanCuda) {
    const rows = (fields.get('GPU_CSV') ?? '')
      .split(/\r?\n/)
      .map((row) => row.split(',').map((value) => value.trim()))
      .filter((row) => row.length >= 3)
    if (rows.length) status.gpu = rows.map((row) => row.slice(0, 2).join(', ')).join('\n')
    const driverVersion = rows[0]?.[2] || /\b\d{3}\.\d+\.\d+\b/.exec(fields.get('DRIVER') ?? '')?.[0]
    const computeCapabilities = rows.map((row) => row[3]).filter((value): value is string => Boolean(value && /^\d+\.\d+$/.test(value)))
    const flavours = [
      ...new Set(libraries.filter((lib) => lib.dependencyCheck === 'passed').map((lib) => `cu${lib.major}` as 'cu12' | 'cu13')),
    ]
    const compatible = (['cu13', 'cu12'] as const).filter((flavour) => driverAllows(driverVersion, flavour))
    const recommendedFlavour = compatible.find((flavour) => flavours.includes(flavour)) ?? compatible[0]
    const standardArchitectureSupported = computeCapabilities.length ? computeCapabilities.some((cap) => Number(cap) >= 8) : undefined
    // Linux has the CUDA 12 SM70 build for Volta and Turing; below 7.0 nothing runs.
    const anyCudaBuild = computeCapabilities.length ? computeCapabilities.some((cap) => Number(cap) >= 7) : undefined
    const pciIds = (fields.get('DRM') ?? '')
      .split(/\r?\n/)
      .map((row) => {
        const [vendor, device] = row.split(':')
        return vendor && device ? drmPciId(vendor, device) : null
      })
      .filter((id): id is string => Boolean(id))
    const nvidiaSmiTimedOut = fields.get('SMI_EXIT') === '124'
    status.cuda = {
      checkedAt,
      durationMs: Date.now() - started,
      driverVersion,
      computeCapabilities,
      libraries,
      flavours,
      ...(nvidiaSmiTimedOut ? { nvidiaSmiTimedOut } : {}),
      gpuNames: rows.map((row) => row[0] ?? '').filter(Boolean),
      pciIds,
      foundFlavours: [...new Set(libraries.map((lib) => `cu${lib.major}` as 'cu12' | 'cu13'))],
      recommendedFlavour,
      recommendedVariant: recommendedFlavour ? (flavours.includes(recommendedFlavour) ? 'system-cuda' : 'bundled') : undefined,
      standardArchitectureSupported,
      gpuReason:
        standardArchitectureSupported === false
          ? `检测到 ${[...new Set(computeCapabilities)].map((cap) => `SM${cap.replace('.', '')}`).join(' / ')}；${anyCudaBuild ? '将使用 CUDA 12 的 SM70 引擎包（需要 525.60.13 或更新的驱动）。' : '没有对应的 Linux CUDA 引擎包（需要 SM70 或更新架构）。'}`
          : undefined,
      error: !libraries.length
        ? '未发现系统 cuBLASLt 12/13。'
        : !flavours.length
          ? '已发现库文件，但依赖检查未通过或不可用；引擎加载时仍需验证实际兼容性。'
          : undefined,
    }
  }
  return status
}
