# 发布源、模型目录与更新

- 状态：`0.0.0` Windows x64 基线 ZIP 已验证；`0.1.0` 正在开发，`githubrelease/` 中已有的包尚不含当前未打包代码改动，需后续重建后再上传
- 决策：[ADR-0005](decisions/0005-release-channel-and-updates.md)
- 发布版本：`0.1.0`（严格版本）；更新测试基线：`0.0.0`

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

> 没有 GitHub Release 时，latest 资产读取会失败，应用仍可能从 raw `main` 或 jsDelivr
> 读取到仓库中的 `release/release.md`。因此界面显示 `source: remote` 不代表 GitHub
> Release/安装资产已存在；线上更新验收必须使用已发布的 Release 资产和可下载 ZIP。

## 2. 文件职责

| 文件 | 角色 |
| --- | --- |
| `release/release.md` | GitHub Release 页面正文 + `json clover-release` 机器块；版本、安装包、首页文案、公告、模型表镜像 |
| `release/manifest.json` | 应用版本/通道/首页文案/公告/安装包元数据的维护源 |
| `release/models.json` | **模型/适配器下载目录的机器源**；应用仍从这里取下载数据 |
| `release/README.md` | 人可读发布说明；生成器会去掉维护者章节 |
| `tools/release-md.mjs` | 从 manifest + models + README 生成 release.md |
| `release/updater.ps1` | Windows ZIP 更新的外置替换/重启程序 |
| `tools/build-release.mjs` | 构建 Windows x64 便携 ZIP、计算大小/SHA-256 并生成上传文件 |
| `githubrelease/` | 当前待手动上传的 `0.1.0` 正式发布材料：ZIP、`release.md` 机器元数据、`README.md` 发布正文 |

`release.md` 中的模型表是发布页镜像，不是第二下载数据源。生成器会校验
`apps/desktop/package.json` 与 `manifest.app.version` 一致，不一致直接失败。修改模型后运行：

```bash
pnpm release:md
pnpm release:md:check
```

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
3. `autoCheckUpdates` 开启时，启动检查；设置页可手动检查；
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
- `0.0.0` 是保留的严格版本基线包，产物在 `release/artifacts/`；`0.1.0` 是本次准备的
   严格正式版本，产物单独放在 `githubrelease/`，两者都不使用 prerelease 后缀。
- GitHub 当前仍没有 Release。`githubrelease/` 中的材料只在手动创建 `v0.1.0` Release
   并上传后才成为线上版本；本地生成文件不代表发布已经完成。
- `manifest.json`/生成的 `release.md` 中的 GitHub 下载地址是版本对应的**预期地址**；
   生成该地址不代表线上 tag 或资产存在。在线 E2E 需上传 `MossStudio-0.1.0-win32-x64.zip`
   和 `release.md`；GitHub Release 正文可使用 `githubrelease/README.md`。从已安装的
   `0.0.0` 客户端检查更新，验证版本识别、下载、SHA-256/大小校验、安全解压和 updater 替换。
- 发布后该版本号不可复用；如果客户端升级到 `0.1.0`，后续更新版本必须严格高于 `0.1.0`。
- SemVer 比较决定是否提示更新；`v` 只是 Git tag 前缀，不属于应用版本。不要通过
  `0.0.0-beta.1` 等 prerelease 后缀改变本地基线。
- 上传前，`0.0.0` 客户端可能通过 raw `main`/镜像读取到仓库中的 `0.1.0` 元数据；
   但下载资产只有在 Release 上传后才可用。上传后再进行真实在线更新测试。
- 代码变更后必须重新构建 `githubrelease/`；已有 ZIP 的哈希不能代表未打包的工作区代码。

## 5. 发布检查清单

1. 同步根目录和 `apps/desktop/package.json` 的版本号及 `release/manifest.json`；
2. 更新 `release/models.json` 和发布说明；
3. 运行 `pnpm release:md:check` 校验版本、安装包元数据和生成文档；
4. 在 Windows x64 运行 `pnpm release:build:github`；产物写入 `githubrelease/`；
5. 创建 `v<version>` GitHub Release，将 ZIP 和 `release.md` 上传为资产，并把
   `README.md` 内容粘贴为 Release 正文；上传完成后再从 `0.0.0` 客户端验收在线更新。

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
pnpm release:build:github
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --scenario=release-parse
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --scenario=update-download
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --scenario=update-dialog
```

Windows PowerShell 可用本地 Electron 二进制运行，并验证刚构建的 `0.1.0` ZIP：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:MOSS_UPDATE_TEST_ZIP = (Resolve-Path 'githubrelease\MossStudio-0.1.0-win32-x64.zip').Path
& .\apps\desktop\node_modules\electron\dist\electron.exe .\apps\desktop --scenario=update-zip
```
