import {
  Bell,
  ExternalLink,
  FolderOpen,
  HardDrive,
  ImagePlus,
  Info,
  MonitorCog,
  Plus,
  RefreshCw,
  Save,
  Terminal,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Ipc } from '@shared/channels'
import type { AppInfo, Settings } from '@shared/types'
import type { WebAccessInfo } from '@shared/backend'
import defaultHomeBackground from '../assets/home-background.png'
import { call } from '../lib/api'
import { cloverUrl } from '../lib/clover'
import { bytes } from '../lib/format'
import { t } from '../lib/i18n'
import { clearSavedSettings, pendingSettings } from '../lib/settingsDraft'
import { useApp } from '../store'
import { Presence } from '../components/motion'
import { Button, Card, IconButton, Input, Pill, Segmented, Select, StatusDot, Switch, useToast } from '../components/ui'

export function SettingsPage(): React.JSX.Element {
  const toast = useToast()
  const { settings, env, devices, updates, saveSettings, refreshEnv, refreshDevices, checkForUpdates } = useApp()
  const [edits, setEdits] = useState<Partial<Settings>>({})
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const [webAccess, setWebAccess] = useState<WebAccessInfo | null>(null)

  useEffect(() => {
    void call<AppInfo>(Ipc.appInfo).then(setAppInfo).catch(() => undefined)
    void refreshWebAccess()
  }, [])

  async function refreshWebAccess(): Promise<void> {
    try {
      setWebAccess(await call<WebAccessInfo>(Ipc.webAccessInfo))
    } catch {
      setWebAccess(null)
    }
  }

  const changes = useMemo(
    () => settings ? pendingSettings(settings, edits) : {},
    [settings, edits],
  )
  const draft = settings ? { ...settings, ...edits } : null
  const dirty = Object.keys(changes).length > 0

  if (!draft) {
    return <div className="py-20 text-center text-ui text-[var(--color-text-tertiary)]">{t('common.loading')}</div>
  }

  function patch(next: Partial<Settings>): void {
    setEdits((previous) => {
      const merged = { ...previous, ...next }
      return settings && !saving ? pendingSettings(settings, merged) : merged
    })
  }

  async function save(): Promise<void> {
    if (!draft || !dirty || saving) return
    setSaving(true)
    try {
      await saveSettings(changes)
      setEdits((previous) => clearSavedSettings(previous, changes))
      toast.push('设置已保存', 'success')
      await Promise.all([refreshEnv(), refreshDevices()])
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function persist(patch: Partial<Settings>): Promise<void> {
    try {
      await saveSettings(patch)
      setEdits((previous) => clearSavedSettings(previous, patch))
      toast.push('已保存', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function addGalleryRoot(): Promise<void> {
    const path = await call<string | null>(Ipc.pickDialog, { kind: 'folder', title: '选择画廊目录' })
    if (!path) return
    const roots = draft?.galleryRoots ?? []
    if (roots.includes(path)) return
    await persist({ galleryRoots: [...roots, path] })
  }

  async function removeGalleryRoot(root: string): Promise<void> {
    const roots = (draft?.galleryRoots ?? []).filter((item) => item !== root)
    await persist({ galleryRoots: roots })
  }

  async function pickTrainerRoot(): Promise<void> {
    const path = await call<string | null>(Ipc.pickDialog, { kind: 'folder', title: '选择训练器根目录' })
    if (!path) return
    await persist({ trainerRoot: path })
  }

  async function pickBackground(): Promise<void> {
    const path = await call<string | null>(Ipc.pickDialog, { kind: 'image', title: '选择首页背景图' })
    if (!path) return
    await persist({ homeBackground: path })
  }

  async function checkUpdates(): Promise<void> {
    const result = await checkForUpdates()
    if (!result) {
      toast.push('检查更新失败，请稍后重试', 'error')
    } else if (result.updateAvailable) {
      toast.push(`发现新版本 ${result.latestVersion}`, 'info')
    } else if (result.error) {
      toast.push(result.error, 'error')
    } else {
      toast.push('当前已是最新版本', 'success')
    }
  }

  async function testNotification(): Promise<void> {
    if (!draft?.desktopNotifications) {
      toast.push('先开启桌面通知', 'info')
      return
    }
    try {
      await saveSettings({ desktopNotifications: true })
      const shown = await call<boolean>(Ipc.notificationTest)
      toast.push(
        shown ? '测试通知已发送' : '系统通知不可用，请检查系统通知权限',
        shown ? 'success' : 'info',
      )
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const selected = env?.network.selected

  return (
    <div className="space-y-5 pb-16">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">{t('settings.title')}</h1>
          <p className="mt-1 text-section text-[var(--color-text-secondary)]">
            动效、网络、存储、设备与运行时修改后保存；目录选择和背景操作立即生效。
          </p>
        </div>
        <Button tone="primary" onClick={() => void save()} disabled={!dirty || saving}>
          <span className="inline-flex items-center gap-1.5">
            <Save className="size-4" /> {saving ? '保存中…' : t('common.save')}
          </span>
        </Button>
      </header>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <Card className="px-5 py-4">
          <h2 className="text-[13px] font-semibold">{t('settings.appearance')}</h2>
          <div className="mt-4 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-ui font-medium">表面</div>
                <div className="mt-0.5 text-ui text-[var(--color-text-tertiary)]">
                  深灰亚克力，跟随系统材质
                </div>
              </div>
              <Pill tone="neutral">Fixed</Pill>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-[var(--color-border-subtle)] pt-3">
              <div>
                <label htmlFor="ui-animation" className="text-ui font-medium">界面动效</label>
                <div className="mt-0.5 text-ui text-[var(--color-text-tertiary)]">
                  跟随系统时尊重减少动态效果的偏好
                </div>
              </div>
              <Select
                id="ui-animation"
                value={draft.uiAnimation}
                onChange={(event) => patch({ uiAnimation: event.target.value as Settings['uiAnimation'] })}
                className="w-[110px] shrink-0"
                options={[
                  { value: 'system', label: '跟随系统' },
                  { value: 'on', label: '开启' },
                  { value: 'off', label: '关闭' },
                ]}
              />
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-[var(--color-border-subtle)] pt-3">
              <div>
                <div className="text-ui font-medium">语言</div>
                <div className="mt-0.5 text-ui text-[var(--color-text-tertiary)]">
                  简体中文优先，英文文案已预留
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Pill tone="accent">简体中文</Pill>
                <Pill tone="neutral">English（soon）</Pill>
              </div>
            </div>
          </div>
        </Card>

        <Card className="px-5 py-4">
          <h2 className="text-[13px] font-semibold">{t('settings.network')}</h2>
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-ui font-medium">策略</div>
                <div className="mt-0.5 text-ui text-[var(--color-text-tertiary)]">
                  自动按延迟选择；镜像失败会回退
                </div>
              </div>
              <Segmented
                label="网络策略"
                value={draft.networkMode}
                onChange={(networkMode) => patch({ networkMode })}
                options={[
                  { value: 'auto', label: '自动' },
                  { value: 'direct', label: '直连' },
                  { value: 'mirror', label: '镜像' },
                ]}
              />
            </div>
            <div className="rounded-lg bg-[var(--color-surface-secondary)] px-3 py-2 text-ui leading-5 text-[var(--color-text-secondary)]">
              <div>git：{selected?.git ?? '直连'}</div>
              <div>pip：{selected?.pip ?? '默认'}</div>
              <div>hf：{selected?.hf ?? '直连'}</div>
            </div>
            {(
              [
                ['gitMirror', 'git 镜像前缀', 'https://ghproxy.net/'],
                ['pipIndex', 'pip index', 'https://pypi.tuna.tsinghua.edu.cn/simple'],
                ['hfEndpoint', 'HF endpoint', 'https://hf-mirror.com'],
              ] as Array<[keyof Settings, string, string]>
            ).map(([key, label, placeholder]) => (
              <label key={String(key)} className="block space-y-1">
                <span className="text-ui text-[var(--color-text-tertiary)]">{label}（留空自动）</span>
                <Input
                  value={String(draft[key] ?? '')}
                  placeholder={placeholder}
                  onChange={(event) => patch({ [key]: event.target.value || null } as Partial<Settings>)}
                  className="w-full font-mono"
                />
              </label>
            ))}
          </div>
        </Card>

        <Card className="px-5 py-4">
          <h2 className="text-[13px] font-semibold">{t('settings.storage')}</h2>
          <div className="mt-3 space-y-3 text-ui">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-ui font-medium">模型目录</div>
                <div className="mt-0.5 break-all font-mono text-ui text-[var(--color-text-tertiary)]">
                  {env?.device.modelsPath ?? appInfo?.modelsPath ?? '—'}
                </div>
              </div>
              <IconButton
                label="打开所在目录"
                onClick={() => env && void call(Ipc.openPath, { path: env.device.modelsPath })}
              >
                <FolderOpen className="size-4" />
              </IconButton>
            </div>
            <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] pt-2.5">
              <span className="inline-flex items-center gap-1.5 text-[var(--color-text-tertiary)]">
                <HardDrive className="size-4" /> 剩余空间
              </span>
              <span>{bytes(env?.device.diskFree)}</span>
            </div>
            <label className="block space-y-1 border-t border-[var(--color-border-subtle)] pt-2.5">
              <span className="text-ui text-[var(--color-text-tertiary)]">自定义模型根目录（留空使用默认）</span>
              <Input
                value={draft.modelsRoot ?? ''}
                placeholder="例如 /Volumes/Data/MossStudio/models"
                onChange={(event) => patch({ modelsRoot: event.target.value || null })}
                className="w-full font-mono"
              />
            </label>
            <div className="flex items-end justify-between gap-2 border-t border-[var(--color-border-subtle)] pt-2.5">
              <label className="min-w-0 flex-1 space-y-1">
                <span className="text-ui text-[var(--color-text-tertiary)]">训练器根目录（Kohaku Trainer）</span>
                <div className="truncate font-mono text-caption text-[var(--color-text-secondary)]">
                  {draft.trainerRoot ?? '默认 .dev-data/trainer'}
                </div>
              </label>
              <Button tone="secondary" onClick={() => void pickTrainerRoot()}>
                选择
              </Button>
            </div>
            <p className="text-ui leading-4 text-[var(--color-text-tertiary)]">
              迁移目录不会自动搬文件；建议先在新位置下载，再删除旧缓存。
            </p>
          </div>
        </Card>

        <Card className="px-5 py-4">
          <h2 className="text-[13px] font-semibold">设备维护</h2>
          <p className="mt-1 text-ui leading-4 text-[var(--color-text-tertiary)]">
            禁用的设备不再出现在启动条；每设备仍默认只跑 1 个推理任务，训练占用本地设备时推理排队。
          </p>
          <div className="mt-3 space-y-1.5">
            {devices.map((device) => {
              const disabled = (draft.disabledDevices ?? []).includes(device.id)
              return (
                <div key={device.id} className="flex items-center gap-2 rounded-[5px] border border-[var(--color-border-subtle)] px-2.5 py-2">
                  <input
                    type="checkbox"
                    checked={!disabled}
                    onChange={(event) => {
                      const next = new Set(draft.disabledDevices ?? [])
                      if (event.target.checked) next.delete(device.id)
                      else next.add(device.id)
                      patch({ disabledDevices: [...next] })
                    }}
                    className="size-3 accent-[var(--color-accent)]"
                  />
                  <span className="min-w-0 flex-1">
                    <Input
                      value={draft.deviceLabels?.[device.id] ?? ''}
                      placeholder={device.name}
                      onChange={(event) => patch({ deviceLabels: { ...(draft.deviceLabels ?? {}), [device.id]: event.target.value } })}
                      className="w-full bg-transparent placeholder:text-[var(--color-text-secondary)]"
                    />
                    <span className="block text-micro text-[var(--color-text-tertiary)]">{device.detail} · {disabled ? '已禁用' : '可用'}</span>
                  </span>
                  <Pill tone={disabled ? 'neutral' : 'accent'}>{disabled ? 'Off' : 'On'}</Pill>
                </div>
              )
            })}
            {devices.length === 0 ? <p className="text-ui text-[var(--color-text-tertiary)]">没有检测到设备。</p> : null}
          </div>
        </Card>

        <Card className="px-5 py-4">
          <h2 className="text-[13px] font-semibold">{t('settings.runtime')}</h2>
          <div className="mt-3 space-y-3 text-ui">
            <label className="block space-y-1">
              <span className="text-ui text-[var(--color-text-tertiary)]">Python 解释器（留空自动发现）</span>
              <Input
                value={draft.pythonPath ?? ''}
                placeholder="/opt/homebrew/bin/python3.12"
                onChange={(event) => patch({ pythonPath: event.target.value || null })}
                className="w-full font-mono"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-ui text-[var(--color-text-tertiary)]">PyTorch 安装</span>
              <Select
                value={draft.torchBackend}
                onChange={(event) => patch({ torchBackend: event.target.value as Settings['torchBackend'] })}
                options={[
                  { value: 'auto', label: '自动（有 NVIDIA 用 CUDA）' },
                  { value: 'cpu', label: 'CPU' },
                  { value: 'cuda', label: 'CUDA' },
                ]}
              />
              <span className="block text-caption leading-4 text-[var(--color-text-tertiary)]">
                Windows/Linux 自动选择 CUDA 轮子；macOS 使用 PyPI MPS 轮子。CUDA 默认 cu128。
              </span>
            </label>
            <label className="block space-y-1">
              <span className="text-ui text-[var(--color-text-tertiary)]">PyTorch 自定义索引（可选）</span>
              <Input
                value={draft.torchIndex ?? ''}
                placeholder="https://download.pytorch.org/whl/cu128"
                onChange={(event) => patch({ torchIndex: event.target.value || null })}
                className="w-full font-mono text-caption"
              />
            </label>
            <div className="rounded-lg bg-[var(--color-surface-secondary)] px-3 py-2">
              <div className="mb-1 text-ui text-[var(--color-text-tertiary)]">已发现</div>
              {env?.pythons.length ? (
                <div className="space-y-0.5">
                  {env.pythons.map((python) => (
                    <div key={python.path} className="flex items-center justify-between gap-2">
                      <span className="font-mono text-ui">{python.version}</span>
                      <span className="truncate text-caption text-[var(--color-text-tertiary)]">
                        {python.source} · {python.path}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-ui text-[var(--color-text-tertiary)]">未发现 Python 3.10+</span>
              )}
            </div>
            <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] pt-2.5">
              <div>
                <div className="text-ui font-medium">依赖缓存</div>
                <div className="mt-0.5 text-ui text-[var(--color-text-tertiary)]">
                  uv / pip 缓存位于应用数据目录
                </div>
              </div>
              <Pill tone="neutral">共享 runtime</Pill>
            </div>
          </div>
        </Card>

        <Card className="px-5 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold">画廊与背景</h2>
            <Pill tone="neutral">{draft.galleryRoots.length} 个自定义路径</Pill>
          </div>
          <p className="mt-1.5 text-ui leading-4 text-[var(--color-text-tertiary)]">
            默认读取应用输出目录与各实例的 outputs；可以添加任意本地文件夹作为画廊来源。
          </p>
          <div className="mt-2.5 space-y-1.5">
            {draft.galleryRoots.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--color-border)] px-2.5 py-2 text-ui text-[var(--color-text-tertiary)]">
                使用默认输出目录
              </div>
            ) : (
              draft.galleryRoots.map((root) => (
                <div
                  key={root}
                  className="flex items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-white/35 px-2.5 py-1.5 dark:bg-white/[0.03]"
                >
                  <FolderOpen className="size-4 shrink-0 text-accent-500" />
                  <span className="min-w-0 flex-1 truncate font-mono text-caption">{root}</span>
                  <IconButton
                    label="移除画廊目录"
                    onClick={() => void removeGalleryRoot(root)}
                    className="text-[var(--color-text-tertiary)] hover:text-red-500"
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              ))
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button tone="secondary" onClick={() => void addGalleryRoot()}>
              <span className="inline-flex items-center gap-1.5">
                <Plus className="size-4" /> 添加文件夹
              </span>
            </Button>
            <Button tone="ghost" onClick={() => void persist({ galleryRoots: [] })}>
              恢复默认
            </Button>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 border-t border-[var(--color-border-subtle)] pt-2.5">
            <div className="min-w-0">
              <div className="text-ui font-medium">首页背景图</div>
              <div className="mt-0.5 truncate text-caption text-[var(--color-text-tertiary)]">
                {draft.homeBackground ?? '默认深灰占位图（16:9）'}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {draft.homeBackground ? (
                <Button tone="ghost" onClick={() => void persist({ homeBackground: null })}>
                  清除
                </Button>
              ) : null}
              <Button tone="secondary" onClick={() => void pickBackground()}>
                <span className="inline-flex items-center gap-1.5">
                  <ImagePlus className="size-4" /> 选择图片
                </span>
              </Button>
            </div>
          </div>
          <div className="mt-2.5 overflow-hidden rounded-[6px] border border-[var(--color-border-subtle)]">
            <img
              src={draft.homeBackground ? cloverUrl(draft.homeBackground) : defaultHomeBackground}
              alt="首页背景预览"
              className="aspect-video w-full object-cover"
            />
          </div>
          <p className="mt-1.5 text-caption text-[var(--color-text-tertiary)]">
            建议 16:9，2560×1440；默认使用内置深灰占位图。
          </p>
        </Card>

        <Card className="px-5 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold">设备与诊断</h2>
            <Button tone="ghost" onClick={() => void refreshEnv()}>
              <span className="inline-flex items-center gap-1.5">
                <MonitorCog className="size-4" /> 重新检测
              </span>
            </Button>
          </div>
          <div className="mt-2.5 space-y-2">
            {(env?.checks ?? []).map((check) => (
              <div key={check.id} className="flex items-start gap-2.5">
                <StatusDot status={check.status} className="mt-1.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-ui font-medium">{check.label}</span>
                    <span className="truncate text-right text-ui text-[var(--color-text-secondary)]">
                      {check.value}
                    </span>
                  </div>
                  {check.detail ? (
                    <p className="mt-0.5 text-caption leading-4 text-[var(--color-text-tertiary)]">{check.detail}</p>
                  ) : null}
                </div>
              </div>
            ))}
            {!env ? <div className="text-ui text-[var(--color-text-tertiary)]">正在检测…</div> : null}
          </div>
        </Card>

        <Card className="px-5 py-4">
          <h2 className="text-[13px] font-semibold">更新、公告与通知</h2>
          <div className="mt-3 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-ui font-medium">启动时检查更新</div>
                <div className="mt-0.5 text-ui text-[var(--color-text-tertiary)]">
                  读取 GitHub Release 的 release.md（本地 release/ 回退）
                </div>
              </div>
              <Switch
                aria-label="启动时检查更新"
                checked={draft.autoCheckUpdates}
                onCheckedChange={(value: boolean) => patch({ autoCheckUpdates: value })}
              />
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-[var(--color-border-subtle)] pt-2.5">
              <div>
                <div className="text-ui font-medium">桌面通知</div>
                <div className="mt-0.5 text-ui text-[var(--color-text-tertiary)]">
                  任务完成/失败、发现新版本时发送系统通知
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  tone="ghost"
                  onClick={() => void testNotification()}
                  disabled={!draft.desktopNotifications}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Bell className="size-4" /> 测试
                  </span>
                </Button>
                <Switch
                  aria-label="桌面通知"
                  checked={draft.desktopNotifications}
                  onCheckedChange={(value: boolean) => patch({ desktopNotifications: value })}
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-[var(--color-border-subtle)] pt-2.5">
              <div>
                <div className="text-ui font-medium">局域网 WebUI</div>
                <div className="mt-0.5 text-ui text-[var(--color-text-tertiary)]">
                  同一 Wi‑Fi 用手机浏览器打开 MossStudio；默认关闭
                </div>
              </div>
              <Switch
                aria-label="局域网 WebUI"
                checked={draft.lanWebEnabled}
                onCheckedChange={(value: boolean) => patch({ lanWebEnabled: value })}
              />
            </div>
            {draft.lanWebEnabled ? (
              <div className="rounded-[5px] border border-[var(--color-border-subtle)] bg-white/[0.025] p-2.5">
                <div className="mb-1 text-caption text-[var(--color-text-tertiary)]">
                  保存后地址会更新；同一网络内拿到链接的人可以访问。
                </div>
                {(webAccess?.urls ?? []).map((url) => (
                  <div key={url} className="flex items-center gap-2 py-0.5">
                    <code className="min-w-0 flex-1 truncate text-caption text-[var(--color-text-secondary)]">{url}</code>
                    <button
                      type="button"
                      className="shrink-0 text-caption text-accent-300 hover:underline"
                      onClick={() => void navigator.clipboard.writeText(url)}
                    >
                      复制
                    </button>
                  </div>
                ))}
                {!webAccess?.ready ? (
                  <div className="text-caption text-amber-300">{webAccess?.error ?? '保存设置后生成地址'}</div>
                ) : null}
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-4 border-t border-[var(--color-border-subtle)] pt-2.5">
              <div>
                <div className="text-ui font-medium">更新通道</div>
                <div className="mt-0.5 text-ui text-[var(--color-text-tertiary)]">
                  Beta 读取 GitHub Release 的 beta pinned 资产；缺失时回退 stable
                </div>
              </div>
              <Select
                value={draft.updateChannel}
                onChange={(event) =>
                  patch({ updateChannel: event.target.value as Settings['updateChannel'] })
                }
              >
                <option value="stable">稳定版</option>
                <option value="beta">Beta</option>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-[var(--color-border-subtle)] pt-2.5">
              <div>
                <div className="text-ui font-medium">当前版本</div>
                <div className="mt-0.5 text-ui text-[var(--color-text-tertiary)]">
                  {appInfo?.version ?? env?.appVersion ?? '0.1.0'} · Electron {appInfo?.electron ?? '—'}
                  {updates?.latestVersion && updates.latestVersion !== (appInfo?.version ?? env?.appVersion)
                    ? ` · 最新 ${updates.latestVersion}`
                    : ''}
                </div>
              </div>
              <Button tone="secondary" onClick={() => void checkUpdates()}>
                <span className="inline-flex items-center gap-1.5">
                  <RefreshCw className="size-4" /> 检查更新
                </span>
              </Button>
            </div>
            <p className="text-ui leading-4 text-[var(--color-text-tertiary)]">
              开发模式优先读取本地 release/release.md；正式包读取 GitHub Release 的 latest 资产，
              失败时回退 raw/缓存。安装包必须带 sha256。
            </p>
          </div>
        </Card>

        <Card className="px-5 py-4">
          <h2 className="text-[13px] font-semibold">{t('settings.about')}</h2>
          <div className="mt-3 space-y-2 text-ui">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] pb-3">
              <span className="inline-flex shrink-0 items-center gap-1.5 text-[var(--color-text-tertiary)]">
                <Info className="size-4" /> 产品
              </span>
              <span className="text-right text-ui font-semibold">{t('app.name')}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-[var(--color-text-tertiary)]">
                <Terminal className="size-4" /> 运行时
              </span>
              <span className="font-mono text-ui">
                Node {appInfo?.node ?? '—'} · Chrome {appInfo?.chrome ?? '—'}
              </span>
            </div>
            <div className="flex items-start justify-between gap-3">
              <span className="shrink-0 text-[var(--color-text-tertiary)]">数据目录</span>
              <span className="break-all text-right font-mono text-caption">{appInfo?.dataPath ?? '—'}</span>
            </div>
            <button
              type="button"
              onClick={() =>
                void call(Ipc.openExternal, { url: 'https://github.com/CloverIris/MossStudio' })
              }
              className="mt-1 inline-flex items-center gap-1.5 text-ui text-accent-600 hover:underline dark:text-accent-300"
            >
              项目主页与文档 <ExternalLink className="size-4" />
            </button>
          </div>
        </Card>
      </div>

      {createPortal(
        <Presence open={dirty} preset="toast" role="status" className="glass-strong fixed bottom-4 left-1/2 z-30 flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-3 px-3 py-2 shadow-lg">
          <span className="text-ui text-[var(--color-text-secondary)]">有未保存的更改</span>
          <Button tone="primary" size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </Presence>,
        document.body,
      )}
    </div>
  )
}
