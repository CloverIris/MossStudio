# 下载 / PyTorch / Windows 审计（2026-10-21）

关联 issue：#8（torch CPU/GPU）、#9（下载取消）、#1/#3（已有修复复核）。

## 1. 模型下载

现状：

- 每个 blob 写 `<blob>.part`，HTTP `Range` 续传；收到 200 会从头写，416 会重试；
- 校验 `.part` 长度/本地 SHA256 后才 rename；完成后 `.clover-owned` + install record；
- 暂停 = abort 当前请求，`.part` 保留；再次开始会等待旧 writer 退出并从 offset 续传；
- 新增取消：abort、等待 writer 退出、移除任务并显示“已取消”；不删除 `.part`，便于之后重新开始（也避免误删共享 blob）；
- 下载任务列表只在内存；应用重启后列表不恢复，但 `.part`/pending record 仍在，重新点下载可续传。

待验收：

- Windows 真实网络下 Range/断点、暂停后立即继续、取消后重新开始；
- 服务器忽略 Range 返回 200 的路径（代码已处理，未做真实服务器测试）；
- 跨应用重启的 UI 任务恢复（目前靠 catalog 的 partial 状态，不恢复进度条）。

## 2. PyTorch CPU/GPU

新增设置：

- `torchBackend`: `auto | cpu | cuda`
- `torchIndex`: 可选自定义 PyTorch wheel 索引

行为：

- Windows/Linux `auto`：`nvidia-smi` 可用时使用 `https://download.pytorch.org/whl/cu128`，否则 CPU 索引；
- macOS `auto`：使用默认 PyPI 轮子（保留 MPS），不强制 CPU；
- `cuda` 在 macOS 上明确报错；
- torch 单独安装，再安装其他依赖，避免 `torch>=2.9` 被 PyPI CPU 轮子覆盖；
- runtime lock hash 加入 torch 索引，CPU/CUDA 不会误复用同一个共享运行时。

待验收：

- Windows NVIDIA 实机安装，确认 `torch.cuda.is_available()` 为 true；
- cu128 与驱动匹配；不匹配时给出可操作错误；
- CUDA 索引网络失败的回退文案。

## 3. Windows

已审计的点：

- Python：优先 `py -3` 的真实解释器，再 PATH，再常见安装目录；
- venv：`Scripts/python.exe`；
- 模型缓存：hardlink 失败时复制，不依赖 Windows symlink/开发者模式；
- git/ssh 走系统命令，`where` 搜索；
- Electron 安装包/NSIS/签名仍没有配置。

仍未验证/未完成：

- Windows 实机 `pnpm dev` / 打包启动；
- Defender/路径长度/非 ASCII 路径；
- 真实 git clone/SSH/训练；
- Windows 安装包、自动更新、签名。

> 当前不能宣称 Windows 已支持；只能宣称代码路径已审计并修了已知的 CPU torch/Python 发现问题。
