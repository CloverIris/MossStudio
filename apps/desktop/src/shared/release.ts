import { z } from 'zod'

export const RELEASE_MARKER = 'clover-release'
export const RELEASE_SCHEMA_VERSION = 2

const installerSchema = z.object({
  platform: z.enum(['darwin', 'win32', 'linux']),
  arch: z.enum(['arm64', 'x64']),
  kind: z.enum(['dmg', 'zip', 'nsis', 'appimage']),
  url: z.string().url().max(4096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  size_bytes: z.number().int().nonnegative(),
})

export const releaseInstallerSchema = installerSchema

const announcementSchema = z.object({
  id: z.string().min(1).max(160),
  level: z.enum(['info', 'success', 'warning', 'critical']),
  title: z.string().min(1).max(240),
  body_markdown: z.string().max(100_000).optional(),
  body_url: z.string().url().max(4096).optional(),
  starts_at: z.string().optional(),
  ends_at: z.string().nullable().optional(),
  dismissible: z.boolean().optional(),
  pinned: z.boolean().optional(),
  action: z
    .object({
      label: z.string().min(1).max(80),
      kind: z.enum(['open_url', 'check_update', 'open_settings']),
      url: z.string().url().max(4096).optional(),
    })
    .optional(),
})
  const homeCopySchema = z.object({
    chapter: z.string().min(1).max(80).optional(),
    title: z.string().min(1).max(120).optional(),
    subtitle: z.string().min(1).max(240).optional(),
  })


const releaseDocumentSchema = z.object({
  schema_version: z.literal(RELEASE_SCHEMA_VERSION),
  app: z.object({
    name: z.string().min(1).max(160),
    channel: z.enum(['stable', 'beta']),
    version: z.string().min(1).max(80),
    min_supported: z.string().max(80).optional(),
    published_at: z.string().min(1).max(80),
    notes_url: z.string().url().max(4096).optional(),
    mandatory: z.boolean().optional(),
  }),
  installers: z.array(installerSchema).max(40).default([]),
  catalog: z
    .object({
      updated_at: z.string().min(1).max(80),
      models_url: z.string().url().max(4096),
      models_sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    })
    .optional(),
  home: homeCopySchema.optional(),
  announcements: z.array(announcementSchema).max(100).default([]),
})

export type ReleaseInstaller = z.infer<typeof installerSchema>
export type ReleaseAnnouncement = z.infer<typeof announcementSchema>
export type ReleaseHomeCopy = z.infer<typeof homeCopySchema>
export type ReleaseDocument = z.infer<typeof releaseDocumentSchema>

export interface ParsedRelease {
  document: ReleaseDocument
  /** Human-readable release notes before the machine block. */
  body: string
  raw: string
}

export type UpdateDownloadPhase =
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'installing'
  | 'ready'
  | 'opened'
  | 'canceled'
  | 'error'

export interface UpdateDownloadState {
  version: string
  phase: UpdateDownloadPhase
  bytes: number
  totalBytes: number
  percent: number
  speedBps: number
  path?: string
  error?: string
  updatedAt: string
}

/**
 * `release.md` contains human notes plus exactly one ```json clover-release```
 * block. The block is the only machine-readable source for release metadata.
 */
export function parseReleaseMarkdown(markdown: string): ParsedRelease {
  const fence = /```json[ \t]+clover-release[^\n]*\r?\n([\s\S]*?)```/i
  const match = markdown.match(fence)
  if (!match?.[1]) throw new Error('release.md 缺少 json clover-release 机器数据块')
  let raw: unknown
  try {
    raw = JSON.parse(match[1])
  } catch (error) {
    throw new Error(`release.md 机器数据不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = releaseDocumentSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`release.md 机器数据格式不合法：${parsed.error.issues[0]?.message ?? 'unknown'}`)
  }
  return {
    document: parsed.data,
    body: markdown.replace(match[0], '').trim(),
    raw: markdown,
  }
}

function parseVersion(value: string): { core: number[]; pre: string[] } | null {
  const cleaned = value.trim().replace(/^v/i, '').split('+')[0]!
  const [core, ...rest] = cleaned.split('-')
  const parts = core!.split('.').map((part) => Number(part))
  if (parts.length === 0 || parts.some((part) => !Number.isInteger(part) || part < 0)) return null
  const pre = rest.length ? rest.join('-').split('.') : []
  return { core: parts, pre }
}

/** Semver comparison with prerelease precedence; returns 1/0/-1. */
export function compareSemver(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return a.localeCompare(b)
  for (let index = 0; index < Math.max(pa.core.length, pb.core.length, 3); index += 1) {
    const diff = (pa.core[index] ?? 0) - (pb.core[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1
  for (let index = 0; index < Math.max(pa.pre.length, pb.pre.length); index += 1) {
    const left = pa.pre[index]
    const right = pb.pre[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right)
      if (diff !== 0) return diff > 0 ? 1 : -1
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1
    } else {
      const diff = left.localeCompare(right)
      if (diff !== 0) return diff > 0 ? 1 : -1
    }
  }
  return 0
}

export function findInstaller(
  installers: ReleaseInstaller[],
  platform: string,
  arch: string,
): ReleaseInstaller | null {
  const normalizedArch = arch === 'aarch64' ? 'arm64' : arch
  return installers.find((item) => item.platform === platform && item.arch === normalizedArch) ?? null
}
