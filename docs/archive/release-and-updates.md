> **Archived (2026-11-06).** Describes the release.md / manifest.json flow that was replaced by the signed update feed. Current process: [docs/release.md](../release.md); decision: [ADR-0010](../decisions/0010-own-installer-and-signed-updates.md).

# 发布源、模型目录与更新

- 状态：`1.0.1` Windows x64 便携 ZIP 已发布为 GitHub Release（tag `1.0.1`，资产 `MossStudio-1.0.1-win32-x64.zip` + `release.md`）；`1.0.2` 在开发中，尚未构建
- 决策：[ADR-0005](../decisions/0005-release-channel-and-updates.md)
- 待发布版本：`1.0.2`（严格版本）；更新验收基线：`1.0.1`

> 截图为 `9.9.9` 测试数据，只展示交互，不是真实发布版本。

## 1. 发布源

> 发布源是**项目 GitHub Release 页面**，不是应用内另建一套 release 元数据；
> 本地 `release/` 只是开发/离线回退。

稳定版默认读取 GitHub Release 的 latest 资产：

```
https://github.com/CloverIris/MossStudio/releases/latest/download/release.md
```

读取顺序：

1. 开发模式：本地 `release/release.md`（`CLOVER_RELEASE_FILE` 可指向测试文件）；
2. 打包模式：latest 资产 → raw `main/release/release.md` → jsDelivr 镜像；
3. `cache/release-v2-<channel>.json` 的最后一次成功文档；
4. 本地 `release/release.md`；
5. 旧 `manifest.json` + `models.json` + `README.md` 的只读回退。

Beta 通道先读 `releases/download/beta/release.md`，不存在时回退 latest/raw。
设置里可选「稳定版 / Beta」。

> 界面显示 `source: remote` 不代表安装资产一定可下载；线上更新验收必须使用已发布
> Release 的资产和可下载 ZIP。
>
> 发布 tag 必须与 `release/manifest.json` 的 `app.notes_url` 中 `/tag/<tag>` 完全一致。
> 当前 Release 的 tag 是 `1.0.1`（不带 `v`）；历史上的 `v1.0.1` 下载地址全部 404，
> 因为仓库里没有同名 tag。`pnpm release:build` 会用 `notes_url` 里的 tag 拼 ZIP 地址，
> 所以先改 `notes_url` 再构建。
>
> `1.0.2` 已用 `pnpm release:build` 构建：`manifest.json` 与 `release.md` 已写入真实 ZIP 的
> URL、大小与 SHA-256，本地产物在 `release/artifacts/`。上传为 GitHub Release 资产后才算发布。

## 2. 文件职责

| 文件 | 角色 |
| --- | --- |
| `release/release.md` | GitHub Release 页面正文 + `json clover-release` 机器块；版本、安装包、首页文案、公告、模型表镜像 |
| `release/manifest.json` | 应用版本/通道/首页文案/公告/安装包元数据的维护源 |
| `release/models.json` | **模型/适配器下载目录的维护源**；构建时随应用打包，应用优先从随包副本读取 |
| `release/README.md` | 人可读发布说明源；构建生成一份移除「发布与更新（维护者）」章节的副本，供粘贴到 GitHub Release 正文 |
| `tools/release-md.mjs` | 从 manifest + models + README 生成 release.md |
| `release/updater.ps1` | Windows ZIP 更新的外置替换/重启程序 |
| `tools/build-release.mjs` | 构建 Windows x64 便携 ZIP、计算大小/SHA-256 并生成发布文件 |
| `release/artifacts/` | 唯一的本地产物目录，已加入 `.gitignore`；包含待上传 ZIP、`release.md` 机器元数据及可粘贴的 `README.md` 正文 |

`release.md` 中的模型表是发布页镜像，不是第二下载数据源。生成器会校验
`apps/desktop/package.json` 与 `manifest.app.version` 一致，不一致直接失败。修改模型后运行：

```bash
pnpm release:md
pnpm release:md:check
```

### GitHub Release 页面：资产与正文

GitHub Release 页面上的**正文（description / release notes）**和**附件资产（assets）**是两个不同位置：

| 本地产物 | 放到 GitHub Release 的位置 | 是否必需 | 用途 |
| --- | --- | --- | --- |
| `release/artifacts/MossStudio-<version>-win32-x64.zip` | 上传为附件资产；文件名保持原样 | 是 | 更新器按 `release.md` 中记录的 URL、大小和 SHA-256 下载并校验 |
| `release/artifacts/release.md` | 上传为附件资产；资产名必须是 `release.md` | 是 | 应用从 `releases/latest/download/release.md` 读取版本、公告、安装包地址等机器数据 |
| `release/artifacts/README.md` | **打开文件、复制全文，粘贴到 GitHub Release 的正文框**；不要仅把文件作为附件上传 | 是（发布页面说明） | 面向用户的 Release 页面说明；不是应用的更新清单 |

创建稳定版时用 `manifest.json` 的 `app.notes_url` 里记录的 tag（当前是 `1.0.2`，不带 `v`；`pnpm release:build` 用它拼 ZIP 下载地址），不要勾选预发布，并将其设为 latest stable release。Release 资产名和 URL 必须与 `manifest.json`/`release.md` 记录完全一致。不要把 `manifest.json`、`models.json`、`rules.json` 或 `updater.ps1` 单独上传：它们是仓库/应用包中的维护源或运行文件，不是 Release 页面机器清单。`release.md` 文件内部同时含人类可读内容和 `clover-release` JSON 块，但更新器需要的是这个**作为附件上传的文件**，不是 Release 正文里的文本。

只把 README 上传为附件不会填充 Release 页面正文；反过来，粘贴 README 正文也不会创建 `README.md` 附件。当前应用更新代码不读取 GitHub Release 页面的正文来解析版本或公告。

### 应用实际读取路径

- **公告/版本/更新器清单**：打包应用先请求 GitHub 稳定版 latest 的 `release.md` 资产；若不可用，再尝试仓库 `main/release/release.md` 和 jsDelivr。只有远端均失败后，才使用成功缓存、应用包内本地 `release.md`，最后才读取旧版 `manifest.json`。所以 no-Release 时，raw `main` 仍可能提供版本/公告数据；它不代表对应 ZIP 已发布。
- **模型列表**：`models.ts` 优先读取应用随包携带的 `release/models.json`。只有找不到本地文件时才尝试远端 catalog；加载失败则使用编译进应用的 builtin catalog。它不从 GitHub Release 页面正文或 `release.md` 的模型表下载列表。
- `release.md` 的 `catalog.models_url` 指向仓库中的 `release/models.json`；其中的模型表是可读镜像。模型 catalog 的实际本地优先级不会因 GitHub Release 创建/缺失而改变。

## 3. release.md 契约

正文给人看；末尾固定一个机器块：

````markdown
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
  "home": {
    "chapter": "万象初绘",
    "title": "一念落纸上，万象入画来。",
    "subtitle": "在 MossStudio 创作，引擎与模型在管理页准备。"
  },
  "installers": [
    {
      "platform": "darwin",
      "arch": "arm64",
      "kind": "dmg",
      "url": "https://github.com/.../MossStudio-0.2.0-arm64.dmg",
      "sha256": "…64 hex…",
      "size_bytes": 123456789
    }
  ],
  "catalog": {
    "updated_at": "2026-10-20T00:00:00Z",
    "models_url": "https://raw.githubusercontent.com/CloverIris/MossStudio/main/release/models.json",
    "models_sha256": "…64 hex…"
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

解析器只接受 `schema_version: 2`；URL 必须是 HTTPS，installer 必须带 64 位 hex sha256。
应用解析器在 `apps/desktop/src/shared/release.ts`。

`home` 是可选字段，用于远程更新 Studio 首页的篇章名、主标题和副标题。字段值按纯文本渲染，不支持 HTML；各项长度由 schema 限制。开发时编辑 `release/manifest.json`，再运行 `pnpm release:md` 生成发布文档。旧版 release 缺少 `home` 时，首页使用应用内置文案；清空字段可回退至默认值，不会影响 Studio 或公告加载。

## 4. 版本与更新流程

1. 应用版本取 `app.getVersion()`；发布版本取 `release.md.app.version`；
2. semver 比较包含 prerelease（`0.2.0-beta.1 < 0.2.0`）；
3. `autoCheckUpdates` 开启时：启动后立即检查，之后每 45 分钟一次，窗口重新获得焦点时补查（5 分钟下限）；设置页可手动检查；
4. 发现新版本：LauncherShell 弹出 UpdateDialog；置顶公告同时进入应用内通知；
5. 用户点「稍后」写入 `dismissedUpdateVersion`，同版本不再自动弹；版本再变重新提示；
6. 用户点「下载并更新」：
   - 选择当前 platform/arch 的 installer；
   - 按 GitHub 加速源回退下载到 `downloads/updates/<version>/`，显示进度/速度/取消；
   - 校验实际文件大小与 sha256；
   - Windows ZIP 使用 Electron/yauzl 安全解压，之后启动外置 updater；
   - updater 等待应用退出，只复制程序文件、保留 `data/` 并重启应用；
   - 测试模式 `CLOVER_UPDATE_TEST=1` 只下载和解压，不替换应用。

网络/文件服务的实现见 `apps/desktop/src/main/services/release.ts` 与
`updateDownload.ts`；UI 见 `components/UpdateDialog.tsx`。

### 版本契约与在线更新测试

- 根目录 `package.json`、`apps/desktop/package.json`、`release/manifest.json` 的
  `app.version` 必须完全一致；打包后以 Electron `app.getVersion()` 为准。发布构建会
  对不一致直接报错，不能只改其中一个版本源。
- `1.0.1` 是当前线上版本（GitHub Release，tag `1.0.1`）；`1.0.2` 是当前开发版本，
  尚未构建发布包。两者都使用严格
   SemVer，不添加 prerelease 后缀。
- 发布构建统一写入 `release/artifacts/`，不创建独立的 `githubrelease/` 目录。GitHub
   创建与 `app.notes_url` 一致的 tag 并上传后，本地材料才成为线上版本。
- `release/README.md` 是 Release 页面正文源，不是应用的更新清单。构建会把去掉维护者章节的正文复制为
   `release/artifacts/README.md`；把该文件内容粘贴到 GitHub Release 正文框。
- `release/artifacts/` 统一保存被 `.gitignore` 忽略的构建输出。GitHub Release 必须上传 ZIP 与名为
   `release.md` 的元数据附件；README 用作页面正文，不要误认为上传 README 附件就等于设置正文。
- `manifest.json`/生成的 `release.md` 中的 GitHub 下载地址是版本对应的**预期地址**；
   生成该地址不代表线上 tag 或资产存在。在线 E2E 需上传 `release/artifacts/` 中对应版本的
   ZIP 和 `release.md`，并把 `README.md` 内容粘贴为 Release 正文。从已安装的
   `1.0.1` 客户端检查更新，验证版本识别、下载、SHA-256/大小校验、安全解压和 updater 替换。
- 发布后该版本号不可复用；如果客户端升级到 `1.0.2`，后续更新版本必须严格高于 `1.0.2`。
- 下载地址由 tag 拼成（`releases/download/<tag>/<asset>`），tag 与 `notes_url` 不一致会
  直接 404：`1.0.1` 曾按 `v1.0.1` 写进文档，实际 tag 是 `1.0.1`，安装包因此无法下载。
- SemVer 比较决定是否提示更新；tag 上的 `v` 只是仓库约定，不属于应用版本。不要通过
  `1.0.2-beta.1` 等 prerelease 后缀改变本地基线。
- 上传前，旧客户端可能通过 raw `main`/镜像读取到开发版本元数据；此时 `1.0.2` 还没有
  安装包，更新弹窗会提示“当前平台暂无安装包”。上传后再进行真实在线更新测试。
- 代码变更后必须重新构建 `release/artifacts/`；已有 ZIP 的哈希不能代表未打包的工作区代码。

## 5. 发布检查清单

1. 同步根目录和 `apps/desktop/package.json` 的版本号及 `release/manifest.json`；
2. 把 `release/manifest.json` 的 `app.notes_url` 指向将要创建的 tag（如 `.../tag/1.0.2`）；
3. 更新 `release/models.json` 和发布说明，运行 `pnpm release:md`；
4. 运行 `pnpm release:md:check` 校验版本、安装包元数据和生成文档；
5. 在 Windows x64 运行 `pnpm release:build`；产物统一写入 `release/artifacts/`，并回填
   `installers` 的 URL、大小与 SHA-256；
6. 创建非预发布、与 `notes_url` 同名的 GitHub Release 并设为 latest；将 `MossStudio-<version>-win32-x64.zip`
   与命名为 `release.md` 的文件上传为资产，再将 `release/artifacts/README.md` 全文粘贴到正文框。
   不要只上传 README 或只填页面正文：两项都需要。上传完成后再从 `1.0.1` 客户端验收在线更新。

## 6. 已知限制

- 当前没有 electron-builder/electron-updater，也没有签名/公证产物；Windows
  更新采用“用户批准 → 镜像回退下载 → 大小/SHA-256 校验 → 安全解压 →
  外置 updater 替换程序文件并重启”的便携 ZIP 流程；
- updater 不自动提权；安装目录必须对当前用户可写。它不会删除安装目录中的 `data/`；
- 本地 Windows x64 构建只验证当前平台；macOS/Linux 安装包和真实 GitHub Release
  在线更新仍需各自平台与线上资产验收；
- `rules.json` 仍在旧文件，不随 `release.md` 迁移；
- 模型表由生成器镜像 models.json；如果只改 release.md 表格，应用下载目录不会变化。

## 7. 验证

```bash
pnpm release:md:check
pnpm typecheck
pnpm build
pnpm release:build
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --scenario=release-parse
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --scenario=update-download
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --scenario=update-dialog
```

Windows PowerShell 可用本地 Electron 二进制运行，并验证刚构建的 ZIP：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:MOSS_UPDATE_TEST_ZIP = (Resolve-Path 'release\artifacts\MossStudio-1.0.2-win32-x64.zip').Path
& .\apps\desktop\node_modules\electron\dist\electron.exe .\apps\desktop --scenario=update-zip
```
