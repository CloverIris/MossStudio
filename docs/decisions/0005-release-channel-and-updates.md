---
status: superseded
date: 2026-10-19
superseded-by: ADR-0010
---

# ADR-0005：GitHub Release 作为唯一发布源，驱动公告、模型目录与更新

- 已被 [ADR-0010](0010-own-installer-and-signed-updates.md) 取代（2026-11-06）：自有安装器、启动器与签名更新源。
- 关联：[ADR-0003](0003-launcher-first.md)、[ADR-0004](0004-workspaces-remote-devices.md)
- 影响：`release/`、`updates.ts`、`models.ts`、通知/公告、更新弹窗、下载与安装、版本体系

## 0. 已确认（2026-10-19）

1. **发布源**：GitHub Release 的 latest 资产
   `https://github.com/CloverIris/MossStudio/releases/latest/download/release.md`；
   开发/离线回退本地 `release/release.md`、raw、缓存；beta 使用 pinned prerelease。
2. **文档格式**：人可读正文 + 固定的 `json clover-release` fenced block。
3. **更新执行**：分阶段。本轮做检测 → 弹窗 → 用户批准 → 下载 → sha256 校验 →
   打开安装包；打包/签名落地后再接 `electron-updater`。
4. **模型目录**：`release/models.json` 继续作为**机器可读的下载目录源**；
   `release.md` 镜像人可读模型表，并引用 models.json 的 `updated_at` / sha256。
   应用仍从 models.json 取下载目录，不从 Markdown 解析模型。
5. **版本策略**：semver + stable/beta；“稍后”按版本记住，版本再变重新提示；
   本轮不强制更新。
6. **安装包矩阵**：先写 macOS arm64 DMG + Windows x64 NSIS 契约；未签名构建
   不宣称自动更新，只允许用户手动打开安装包。

## 1. 背景

当前发布信息被拆成三份，而且都不在 GitHub Release 页面：

| 文件 | 现在负责 | 问题 |
| --- | --- | --- |
| `release/manifest.json` | 版本、公告入口、镜像、推荐 commit | JSON 不适合直接作为发布页内容 |
| `release/models.json` | 模型/适配器目录 | 与公告、版本分离，发布时容易漂移 |
| `release/README.md` | 公告正文 | 又被 `body_url` 间接引用，三份内容互相同步 |

`updates.ts` 已经能读 `manifest.json`、比较版本、拉公告，但：

- 只显示“发现新版本”通知，没有更新弹窗；
- 没有下载地址、安装包校验、下载进度、安装动作；
- 模型目录仍从 `models.json` 单独拉取；
- 公告、版本、模型可能来自不同时间点，无法保证一次发布原子一致；
- 当前仓库没有打包/签名流程，也没有 `electron-updater` / `electron-builder`。

用户要求：**项目的 GitHub Release 页面是发布源，不是应用内另一套 release 元数据**；
模型列表、公告、版本与安装包信息应在同一份 Markdown 里维护；应用检查该文件版本，
发现变化后向用户展示更新，用户批准后下载并更新。

## 2. 目标

1. GitHub Release 上的一份 Markdown 同时是：
   - 人可读的发布页/更新说明；
   - 机器可读的版本、安装包、模型/适配器目录、公告。
2. 应用只从一个版本化文档取发布信息，避免 manifest/models/README 三处漂移。
3. 版本变化能触发更新提示；用户批准后下载、校验、安装。
4. 模型目录可以独立于应用版本更新（模型上新不必发新版应用）。
5. 无网络/被墙/旧版本时有明确的本地缓存与兼容回退。
6. 不把“代码路径存在”写成“自动更新已验证”；签名/公证/打包未完成前必须如实标注。

## 3. 建议决策

### 3.1 发布源

- 仓库：`CloverIris/MossStudio`。
- 稳定版使用 GitHub Release 的 latest 资产：

  ```
  https://github.com/CloverIris/MossStudio/releases/latest/download/release.md
  ```

- 开发/离线回退：
  1. 工作区 `release/release.md`；
  2. GitHub Release 资产；
  3. GitHub raw 的 `main/release/release.md`（可选网络镜像）；
  4. 本地 cache 的最后一次成功文档；
  5. 旧 `release/manifest.json` + `release/models.json`（迁移期只读）。
- **默认不走 GitHub API**，避免 rate limit 和 token；`releases/latest/download/...`
  是稳定重定向。
- 预发布/beta 的 URL 规则待定；不能把 prerelease 混进 `latest`。

### 3.2 单一 Markdown 文档

`release.md` 由两部分组成：

1. 人可读的发布说明（Markdown 正文，会显示在 GitHub Release 页面）；
2. 一个带固定标记的 fenced JSON 块，作为应用解析的唯一机器数据：

````markdown
# MossStudio 0.2.0

本次更新……

```json clover-release
{
  "schema_version": 2,
  "app": {
    "name": "MossStudio",
    "channel": "stable",
    "version": "0.2.0",
    "min_supported": "0.1.0",
    "published_at": "2026-10-20T00:00:00Z",
    "notes_url": "https://github.com/CloverIris/MossStudio/releases/tag/v0.2.0"
  },
  "installers": [
    {
      "platform": "darwin",
      "arch": "arm64",
      "kind": "dmg",
      "url": "https://github.com/.../MossStudio-0.2.0-arm64.dmg",
      "sha256": "…",
      "size_bytes": 123456789
    }
  ],
  "catalog": {
    "updated_at": "2026-10-20T00:00:00Z",
    "models_url": "https://raw.githubusercontent.com/CloverIris/MossStudio/main/release/models.json",
    "models_sha256": "…"
  },
  "announcements": [
    {
      "id": "2026-10-release",
      "level": "info",
      "title": "0.2.0 已发布",
      "body_markdown": "……",
      "starts_at": "2026-10-20T00:00:00Z",
      "ends_at": null,
      "dismissible": true,
      "pinned": true,
      "action": { "label": "查看更新", "kind": "check_update" }
    }
  ]
}
```
````

- 应用只解析 `json clover-release` 代码块；没有该块视为格式错误。
- 正文中由 `models.json` 生成人可读的 Models/Adapters 表，供 GitHub Release 页面查看；
  表格不是第二数据源，应用不从表格解析模型。
- 公告正文直接内联，不再需要 `body_url`；如需外链，只能作为补充，不作为唯一内容。
- `rules.json` 本轮暂不迁入，避免把诊断规则编辑器一起扩大；后续可迁。

### 3.3 版本与通道

- 应用版本以 `package.json` / `app.getVersion()` 为准，发布版本以 `release.md.app.version`
  为准。
- 使用 semver（含 prerelease 比较）；`0.2.0 > 0.2.0-beta.1 > 0.1.0`。
- `channel: stable | beta`；beta 不能通过 `latest` 资产发布。
- `published_at`、`min_supported`、可选 `mandatory`。
- 更新判断：`release.version > app.getVersion()`。
- 模型目录判断：`catalog.updated_at` 变化时刷新，不要求应用版本变化。
- 用户选择“稍后”时记录 `dismissedUpdateVersion`；同版本不再自动弹，版本再变重新提示。

### 3.4 更新流程

1. 启动时（`autoCheckUpdates`）和设置页手动检查；
2. 解析 `release.md`，比较版本；
3. 若更新可用：在公告里给入口，并弹一次更新弹窗，展示版本、发布说明、安装包大小/平台；
4. 用户点“下载并安装”后：
   - 选择当前 `platform + arch` 的 installer；
   - 下载到 `<userData>/downloads/updates/<version>/`，显示进度/速度/取消；
   - 必须校验 `sha256`；校验失败删除并报错；
   - 校验通过后启动安装程序（macOS dmg/zip、Windows NSIS exe）；
5. 用户完成安装；应用不静默重启。

**关于“自动更新”**：真正的后台下载 + 退出时安装 + 重启，需要 `electron-updater`
与已签名/公证的打包产物。当前仓库没有打包管线，因此本轮建议先实现
**用户批准的下载 + 校验 + 打开安装程序**，把 `UpdateInstaller` 抽象出来；
打包/签名落地后再接 `electron-updater`，不改变 `release.md` 契约。

### 3.5 公告与模型目录

- `announcements` 从 `release.md` 读取，保留现有筛选/排序/`dismissible`/`pinned`/action 语义；
- **`release/models.json` 继续是机器可读的下载目录源**，应用仍从它取模型/适配器；
- `release.md` 正文包含由 models.json 生成的人可读模型表，机器块只引用
  `catalog.updated_at` / `models_url` / `models_sha256`；
- 发布页模型表与 models.json 由生成脚本保持同步，避免手写两份；
- 本机安装状态仍由本地扫描决定，远端只提供“可下载目录”；
- 缓存写 `<userData>/cache/release.json`（含原始 Markdown/解析结果/ETag/抓取时间）；
- 失败时回退旧 `manifest.json` + `models.json`，只读，不再新增字段。

### 3.6 安全与信任

- 只接受 `https://` 的 release/installer URL；GitHub 域名可加白名单；
- installer 必须带 `sha256`，缺失则禁止安装（允许“仅查看发布说明”）；
- 下载完成前不执行、不打开；
- 未来打包必须 macOS 签名/公证、Windows 代码签名；未签名构建在 UI 标注不可自动更新；
- `release.md` 本身通过 HTTPS 获取；如果未来需要防篡改，再引入签名层，不在本轮
  假装 sha256 等于供应链签名。

## 4. 数据模型草案

```ts
type UpdateChannel = 'stable' | 'beta'

interface ReleaseInstaller {
  platform: 'darwin' | 'win32' | 'linux'
  arch: 'arm64' | 'x64'
  kind: 'dmg' | 'zip' | 'nsis' | 'appimage'
  url: string
  sha256: string
  size_bytes: number
}

interface ReleaseCatalog {
  updated_at: string
  models: RawModel[]
  adapters?: RawAdapter[]
}

interface ReleaseCatalogRef {
  updated_at: string
  models_url: string
  models_sha256: string
}

interface ReleaseDocument {
  // ...
  installers: ReleaseInstaller[]
  catalog: ReleaseCatalogRef
  announcements: RawAnnouncement[]
}
```

`UpdateState` 追加：`releaseNotes`、`installer`（匹配当前平台）、`publishedAt`、
`mandatory`、`releaseUrl`、`downloadState`。保留现有 `announcements` 字段。

## 5. 迁移

1. 新增 `release/release.md`，正文放发布说明与由 models.json 生成的模型表；
2. `models.ts` **继续读 `models.json`**，不把模型下载目录迁到 Markdown 解析器；
3. `updates.ts` 拆成 `release.ts`（抓取/解析/缓存）+ `updateService.ts`（比较/下载/安装）；
4. 提供 `tools/release-md.mjs` 从 `manifest.json` + `models.json` + `README.md`
   生成 `release.md`，避免发布页模型表与 models.json 漂移；
5. 设置增加 `dismissedUpdateVersion`；
6. 新增更新弹窗、下载进度、安装入口；
7. 保留一个版本的旧 JSON 回退，验证后再删除；
8. 真实下载/安装只能标 🟡，直到有打包产物与签名验证。

## 6. 非目标

- 本轮不实现代码签名/公证/打包（没有打包管线）；
- 不实现静默后台安装；
- 不把诊断规则迁入 `release.md`；
- 不做账号、灰度服务端、遥测；
- 不把 GitHub Release 当对象存储托管 27 GB 权重。

## 7. 已确认，剩余实现细项

以上 6 个方向已确认；实现前还要定：

1. beta 的具体 pinned tag 命名（例如 `beta` / `v0.2.0-beta.1`）与资产命名；
2. 安装包文件名与 `release.md` 中 `kind` 的对应（dmg/zip/nsis）；
3. 生成 `release.md` 后如何上传为 GitHub Release 资产（手动/CI）；
4. 更新下载缓存清理策略与断点续传是否本轮做；
5. 未签名构建的提示文案与禁止安装的判定。

## 8. 实现状态（2026-10-19）

已接代码路径：

- `shared/release.ts`：`json clover-release` 解析、semver（含 prerelease）、平台 installer 匹配；
- `main/services/release.ts`：latest/beta/raw/jsDelivr/本地/cache/旧 manifest 回退；
- `main/services/updateDownload.ts`：下载进度、sha256 校验、打开安装包；
- `UpdateDialog`：版本/平台/大小/发布说明/稍后/下载/取消；
- 设置页：更新通道、检查更新、当前/最新版本；
- `tools/release-md.mjs`：从 manifest + models + README 生成 `release.md`；
- 场景：`release-parse`、`update-download`、`update-dialog`。

仍未验收：

- 真实 GitHub Release 资产与 beta tag；
- 真实签名/公证安装包；
- `electron-updater` 静默安装与重启；
- Windows 实机安装。
