import type { LocalEngineVersion, MossInferRelease } from './types'
import { enginePackageId, parseEnginePackageId, type EnginePackage } from './enginePackages'

/**
 * What a managed engine folder name says about the build inside it.
 *
 * Managed installs live in `<root>/<stamp>` where the stamp is written by the
 * downloader: `stable-<tag>-<packageId>` for releases and
 * `dev-run<id>-<sha>-<packageId>` for CI artifacts, the package id being
 * `cu13`, `cu13-sm75-system-cuda`, `cu12-sm70`, `vulkan`, `hip` (enginePackages.ts).
 */
export interface EngineStamp {
  channel: 'stable' | 'dev'
  /** Release tag (`v1.0.3`) or CI run label (`run42-abcdef12`). */
  tag: string
  packageId: string
  package: EnginePackage
}

const STAMP = /^(stable|dev)-(.+?)-((?:cu12|cu13)(?:-sm75|-sm70)?(?:-system-cuda)?|vulkan|hip)$/

export function parseEngineStamp(name: string): EngineStamp | null {
  const match = STAMP.exec(name.trim())
  if (!match) return null
  const [, channel, tag, id] = match
  const pkg = parseEnginePackageId(id!)
  if (!pkg) return null
  return { channel: channel as EngineStamp['channel'], tag: tag!, packageId: enginePackageId(pkg), package: pkg }
}

export function engineStampName(channel: 'stable' | 'dev', tag: string, pkg: EnginePackage): string {
  return `${channel}-${tag}-${enginePackageId(pkg)}`
}

/** Numeric parts of a tag like `v1.10.2-rc1` → [1, 10, 2]. Null when it has none. */
function versionParts(tag: string): number[] | null {
  const match = /(\d+(?:\.\d+)*)/.exec(tag)
  return match ? match[1]!.split('.').map(Number) : null
}

/** Positive when `a` is newer than `b`. Tags without numbers compare as equal. */
export function compareEngineTags(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  if (!left || !right) return 0
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** The version people see: `1.0.3` for a release, the folder name otherwise. */
export function engineDisplayVersion(version: Pick<LocalEngineVersion, 'name' | 'source'> | null | undefined): string | null {
  if (!version) return null
  const stamp = parseEngineStamp(version.name)
  // An unstamped folder named like a tag (v2.1.1) reads like a release: no leading "v".
  if (!stamp) return version.name.replace(/^v(?=\d)/i, '')
  if (stamp.channel === 'dev') return `开发版 ${stamp.tag}`
  return stamp.tag.replace(/^v/i, '')
}

export type EngineUpdateStatus =
  | { kind: 'not-installed' }
  /** A custom or CI build: the release feed says nothing about it. */
  | { kind: 'unmanaged' }
  | { kind: 'current'; tag: string }
  | { kind: 'available'; tag: string; latest: MossInferRelease }

/** Whether a newer stable release than the engine in use exists. */
export function engineUpdateStatus(
  current: Pick<LocalEngineVersion, 'name' | 'source'> | null | undefined,
  releases: MossInferRelease[],
): EngineUpdateStatus {
  if (!current) return { kind: 'not-installed' }
  const stamp = current.source === 'managed' ? parseEngineStamp(current.name) : null
  if (!stamp || stamp.channel !== 'stable') return { kind: 'unmanaged' }
  const latest = [...releases].sort((a, b) => compareEngineTags(b.tag, a.tag))[0]
  if (latest && compareEngineTags(latest.tag, stamp.tag) > 0) return { kind: 'available', tag: stamp.tag, latest }
  return { kind: 'current', tag: stamp.tag }
}
