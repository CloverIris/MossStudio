#!/usr/bin/env node
/**
 * Generates release/release.md from release/manifest.json + release/models.json.
 *
 * models.json remains the machine-readable download catalog. This document is
 * the human-facing GitHub Release page plus the small `clover-release` JSON
 * block the launcher reads for version/installers/announcements.
 *
 * Usage:
 *   node tools/release-md.mjs
 *   node tools/release-md.mjs --check
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const releaseDir = join(root, 'release')
const manifest = JSON.parse(readFileSync(join(releaseDir, 'manifest.json'), 'utf8'))
const catalog = JSON.parse(readFileSync(join(releaseDir, 'models.json'), 'utf8'))
const appPackage = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'))
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const readme = readFileSync(join(releaseDir, 'README.md'), 'utf8')
const modelsRaw = readFileSync(join(releaseDir, 'models.json'))
const catalogSha = createHash('sha256').update(modelsRaw).digest('hex')

const version = manifest.app?.version
const validVersion =
  typeof version === 'string' &&
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)

if (!validVersion) {
  console.error(`invalid release version: ${version}`)
  process.exit(1)
}
if (appPackage.version !== version || rootPackage.version !== version) {
  console.error(
    `version mismatch: package.json=${rootPackage.version} apps/desktop/package.json=${appPackage.version} manifest=${version}`,
  )
  process.exit(1)
}

const check = process.argv.includes('--check')
const target = join(releaseDir, 'release.md')

function cell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

function size(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const gb = bytes / 1e9
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

function modelTable(models) {
  if (!models?.length) return '_暂无_'
  const rows = models.map((model) =>
    [
      `\`${cell(model.id)}\``,
      cell(model.name),
      `\`${cell(model.repo)}\``,
      cell(model.role),
      cell(model.precision),
      size(model.size_bytes),
      cell(model.license),
      (model.tags ?? []).map((tag) => `\`${cell(tag)}\``).join(' '),
    ].join(' | '),
  )
  return [
    '| ID | 名称 | 仓库 | 角色 | 精度 | 大小 | 许可 | 标签 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row} |`),
  ].join('\n')
}

function adapterTable(adapters) {
  if (!adapters?.length) return '_暂无_'
  const rows = adapters.map((adapter) =>
    [
      `\`${cell(adapter.id)}\``,
      cell(adapter.name),
      `\`${cell(adapter.repo)}\``,
      cell(adapter.kind),
      cell(adapter.base ?? '—'),
      size(adapter.size_bytes),
      cell(adapter.license),
      (adapter.files ?? []).map((file) => `\`${cell(file)}\``).join(' '),
    ].join(' | '),
  )
  return [
    '| ID | 名称 | 仓库 | 类型 | 基座 | 大小 | 许可 | 文件 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row} |`),
  ].join('\n')
}

const installers = manifest.installers ?? manifest.assets ?? []
if (!Array.isArray(installers)) {
  console.error('installers must be an array')
  process.exit(1)
}
const seenInstallers = new Set()
for (const item of installers) {
  const key = `${item?.platform}/${item?.arch}`
  if (
    !item ||
    !['darwin', 'win32', 'linux'].includes(item.platform) ||
    !['arm64', 'x64'].includes(item.arch) ||
    !['dmg', 'zip', 'nsis', 'appimage'].includes(item.kind) ||
    !/^https:\/\//.test(item.url ?? '') ||
    !/^[a-f0-9]{64}$/i.test(item.sha256 ?? '') ||
    !Number.isSafeInteger(item.size_bytes) ||
    item.size_bytes <= 0 ||
    seenInstallers.has(key)
  ) {
    console.error(`invalid or duplicate installer entry: ${key}`)
    process.exit(1)
  }
  seenInstallers.add(key)
}

const announcements = (manifest.announcements ?? []).map((item) => ({
  id: item.id,
  level: item.level ?? 'info',
  title: item.title ?? '公告',
  ...(item.body_markdown ? { body_markdown: item.body_markdown } : {}),
  ...(item.body_url ? { body_url: item.body_url } : {}),
  starts_at: item.starts_at,
  ends_at: item.ends_at ?? null,
  dismissible: item.dismissible ?? true,
  pinned: item.pinned ?? false,
  ...(item.action ? { action: item.action } : {}),
}))

const machine = {
  schema_version: 2,
  app: {
    name: manifest.app?.name ?? 'MossStudio',
    channel: manifest.app?.channel === 'beta' ? 'beta' : 'stable',
    version: manifest.app?.version,
    ...(manifest.app?.min_supported ? { min_supported: manifest.app.min_supported } : {}),
    published_at: manifest.app?.published_at,
    ...(manifest.app?.notes_url ? { notes_url: manifest.app.notes_url } : {}),
    ...(manifest.app?.mandatory ? { mandatory: true } : {}),
  },
  installers: installers.map((item) => ({
    platform: item.platform,
    arch: item.arch,
    kind: item.kind,
    url: item.url,
    sha256: item.sha256,
    size_bytes: item.size_bytes,
  })),
  ...(manifest.home
    ? {
        home: {
          chapter: manifest.home.chapter,
          title: manifest.home.title,
          subtitle: manifest.home.subtitle,
        },
      }
    : {}),
  catalog: {
    updated_at: catalog.updated_at ?? manifest.app?.published_at,
    models_url:
      manifest.catalog?.models_url ??
      'https://raw.githubusercontent.com/CloverIris/MossStudio/main/release/models.json',
    models_sha256: catalogSha,
  },
  announcements,
}

const notes = readme
  .replace(/^#\s+.*\r?\n+/, '')
  .replace(/\n## 发布与更新（维护者）[\s\S]*?(?=\n## |$)/, '\n')
  .trim()
const announcementText = announcements
  .map((item) => {
    const date = item.starts_at ? ` · ${item.starts_at}` : ''
    const body =
      item.body_markdown ??
      (item.body_url?.includes('/release/README.md') ? '详见下方「发布说明」。' : item.body_url ?? '')
    return `### ${item.title}\n\n> ${item.level}${date}\n\n${body}`.trim()
  })
  .join('\n\n')

const installerText = installers.length
  ? installers
      .map(
        (item) =>
          `- \`${item.platform}/${item.arch}\` · ${item.kind} · ${size(item.size_bytes)} · \`${item.sha256.slice(0, 12)}…\``,
      )
      .join('\n')
  : '_当前发布未附带安装包。_'

const document = `# MossStudio ${manifest.app?.version ?? 'dev'}

> 本文件由 \`node tools/release-md.mjs\` 从 \`release/manifest.json\` 与
> \`release/models.json\` 生成；请勿直接手改。发布时把本文件作为 GitHub Release
> 的 \`release.md\` 资产上传。

- 通道：**${manifest.app?.channel ?? 'stable'}**
- 发布：${manifest.app?.published_at ?? '—'}
- 最低版本：${manifest.app?.min_supported ?? '—'}
- 模型目录：${catalog.updated_at ?? '—'} · \`sha256:${catalogSha.slice(0, 12)}…\`

## 安装包

${installerText}

## 模型目录

${modelTable(catalog.models)}

## 适配器

${adapterTable(catalog.adapters)}

## 公告

${announcementText || '_暂无公告。_'}

## 发布说明

${notes}

\`\`\`json clover-release
${JSON.stringify(machine, null, 2)}
\`\`\`
`

if (check) {
  const current = readFileSync(target, 'utf8')
  if (current !== document) {
    console.error('release/release.md is out of date; run: pnpm release:md')
    process.exit(1)
  }
  console.log('release/release.md is up to date')
  process.exit(0)
}

writeFileSync(target, document, 'utf8')
console.log(`wrote ${target}`)
