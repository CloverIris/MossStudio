import {
  Bell,
  Copy,
  Cpu,
  ExternalLink,
  FolderOpen,
  Globe,
  HardDrive,
  ImagePlus,
  Info,
  Palette,
  Plus,
  RefreshCw,
  Save,
  Terminal,
  Trash2,
  Wifi,
  Wrench,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
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
import { Button, Card, IconButton, Input, Pill, Segmented, Select, StatusDot, Switch, cn, useCopyText, useToast } from '../components/ui'

type SectionId = 'appearance' | 'storage' | 'network' | 'alerts' | 'lan' | 'devices' | 'tools' | 'diagnostics'

const SECTIONS: Array<{ id: SectionId; label: string; hint: string; icon: typeof Palette }> = [
  { id: 'appearance', label: '外观与交互', hint: '主题、动效、语言、首页背景', icon: Palette },
  { id: 'storage', label: '存储与画廊', hint: '数据/模型目录、磁盘、画廊来源', icon: HardDrive },
  { id: 'network', label: '网络与下载', hint: '直连/镜像、HF 端点、凭据', icon: Globe },
  { id: 'alerts', label: '通知与更新', hint: '桌面通知、更新通道', icon: Bell },
  { id: 'lan', label: '局域网访问', hint: '手机浏览器打开 Studio', icon: Wifi },
  { id: 'devices', label: '设备', hint: '启用/禁用与别名', icon: Cpu },
  { id: 'tools', label: '训练与外部工具', hint: '仅 Trainer / GBC 使用', icon: Wrench },
  { id: 'diagnostics', label: '诊断与关于', hint: '环境检查、版本、诊断信息', icon: Info },
]

/** One labelled row inside a settings card; separators are handled by the parent. */
function Row({ title, hint, children, stacked = false }: {
  title: string
  hint?: string
  children: React.ReactNode
  stacked?: boolean
}): React.JSX.Element {
  return (
    <div className={cn('py-3 first:pt-0 last:pb-0', stacked ? 'space-y-2' : 'flex items-start justify-between gap-4')}>
      <div className="min-w-0">
        <div className="text-ui font-medium">{title}</div>
        {hint ? <div className="mt-0.5 text-ui leading-5 text-[var(--color-text-tertiary)]">{hint}</div> : null}
      </div>
      <div className={stacked ? 'w-full' : 'shrink-0'}>{children}</div>
    </div>
  )
}

export function SettingsPage(): React.JSX.Element {
  const toast = useToast()
  const copyText = useCopyText()
  const navigate = useNavigate()
  const { settings, env, devices, updates, saveSettings, refreshEnv, refreshDevices, checkForUpdates } = useApp()
  const [edits, setEdits] = useState<Partial<Settings>>({})
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const [webAccess, setWebAccess] = useState<WebAccessInfo | null>(null)
  const [section, setSection] = useState<SectionId>('appearance')

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

  async function openPath(path: string | undefined, label: string): Promise<void> {
    if (!path) {
      toast.push(`${label}尚未就绪，请先刷新环境检测`, 'info')
      return
    }
    try {
      await call(Ipc.openPath, { path })
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
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
      await Promise.all([refreshEnv(), refreshDevices(), refreshWebAccess()])
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

  async function pickEngineRoot(): Promise<void> {
    const path = await call<string | null>(Ipc.pickDialog, { kind: 'folder', title: '选择引擎安装目录' })
    if (!path) return
    await persist({ engineRoot: path })
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

  async function copyDiagnostics(): Promise<void> {
    const lines = [
      `MossStudio ${appInfo?.version ?? env?.appVersion ?? '0.1.0'}`,
      `Electron ${appInfo?.electron ?? '—'} · Chrome ${appInfo?.chrome ?? '—'} · Node ${appInfo?.node ?? '—'}`,
      `OS ${appInfo?.platform ?? '—'} ${appInfo?.arch ?? '—'} · ${env?.device.osVersion ?? '—'}`,
      `GPU ${env?.gpu.name ?? '—'}${env?.gpu.cuda ? ` · CUDA ${env.gpu.cuda}` : ''}`,
      `数据目录 ${appInfo?.dataPath ?? '—'}`,
      `模型目录 ${env?.device.modelsPath ?? '—'}`,
      `引擎 ${settings?.mossInferServerPath ?? '未配置'} · tier ${settings?.mossInferTier ?? '—'} · ${settings?.mossInferVariant ?? '—'}`,
    ]
    await copyText(lines.join('\n'), '诊断信息已复制')
  }

  const selected = env?.network.selected
  const active = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0]

  return (
    <div className="flex min-h-0 flex-1 items-start gap-6 pb-16">
      <nav aria-label="设置分区" className="sticky top-0 hidden w-[192px] shrink-0 lg:block">
        <div className="space-y-0.5">
          {SECTIONS.map((item) => {
            const Icon = item.icon
            const on = item.id === section
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                aria-current={on ? 'page' : undefined}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-ui transition-colors',
                  on ? 'bg-white/[0.07] text-[var(--color-text)]' : 'text-[var(--color-text-secondary)] hover:bg-white/[0.04]',
                )}
              >
                <Icon className={cn('size-4 shrink-0', on ? 'text-accent-300' : 'text-[var(--color-text-tertiary)]')} />
                <span className="truncate">{item.label}</span>
              </button>
            )
          })}
        </div>
      </nav>

      <div className="min-w-0 flex-1 space-y-4">
        <header className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-tight">{t('settings.title')}</h1>
            <p className="mt-1 text-section text-[var(--color-text-secondary)]">{active.hint}</p>
          </div>
          <Button tone="primary" onClick={() => void save()} disabled={!dirty || saving}>
            <span className="inline-flex items-center gap-1.5">
              <Save className="size-4" /> {saving ? '保存中…' : t('common.save')}
            </span>
          </Button>
        </header>

        <div className="lg:hidden">
          <Select value={section} onChange={(event) => setSection(event.target.value as SectionId)}>
            {SECTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </Select>
        </div>

        {section === 'appearance' ? (
          <>
            <Card className="px-5 py-4">
              <h2 className="text-[13px] font-semibold">外观</h2>
              <div className="mt-2 divide-y divide-[var(--color-border-subtle)]">
                <Row title="主题" hint="当前版本固定深色；浅色主题在 Electron 原生外观稳定后再开放。">
                  <Pill tone="neutral">深色</Pill>
                </Row>
                <Row title="界面动效" hint="「跟随系统」会尊重系统的减少动态效果偏好。">
                  <Select
                    value={draft.uiAnimation}
                    onChange={(event) => patch({ uiAnimation: event.target.value as Settings['uiAnimation'] })}
                    className="w-[124px]"
                    options={[
                      { value: 'system', label: '跟随系统' },
                      { value: 'on', label: '开启' },
                      { value: 'off', label: '关闭' },
                    ]}
                  />
                </Row>
                <Row title="语言" hint="文案已按 zh-CN 组织，英文界面待翻译。">
                  <div className="flex items-center gap-1.5">
                    <Pill tone="accent">简体中文</Pill>
                    <Pill tone="neutral">English（soon）</Pill>
                  </div>
                </Row>
              </div>
            </Card>

            <Card className="px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[13px] font-semibold">首页背景</h2>
                <div className="flex items-center gap-1">
                  {draft.homeBackground ? (
                    <Button tone="ghost" onClick={() => void persist({ homeBackground: null })}>清除</Button>
                  ) : null}
                  <Button tone="secondary" onClick={() => void pickBackground()}>
                    <span className="inline-flex items-center gap-1.5">
                      <ImagePlus className="size-4" /> 选择图片
                    </span>
                  </Button>
                </div>
              </div>
              <p className="mt-1 break-all font-mono text-caption text-[var(--color-text-tertiary)]">
                {draft.homeBackground ?? '默认深灰占位图（16:9）'}
              </p>
              <div className="mt-2.5 overflow-hidden rounded-[6px] border border-[var(--color-border-subtle)]">
                <img
                  src={draft.homeBackground ? cloverUrl(draft.homeBackground) : defaultHomeBackground}
                  alt="首页背景预览"
                  className="aspect-video w-full object-cover"
                />
              </div>
              <p className="mt-1.5 text-caption text-[var(--color-text-tertiary)]">建议 16:9，2560×1440。</p>
            </Card>
          </>
        ) : null}

        {section === 'storage' ? (
          <>
            <Card className="px-5 py-4">
              <h2 className="text-[13px] font-semibold">位置</h2>
              <div className="mt-2 divide-y divide-[var(--color-border-subtle)]">
                <Row title="数据目录" hint="设置、工程、任务记录都在这里。">
                  <div className="flex items-center gap-1">
                    <span className="max-w-[220px] truncate font-mono text-caption text-[var(--color-text-secondary)]">
                      {appInfo?.dataPath ?? '—'}
                    </span>
                    <IconButton label="打开数据目录" onClick={() => void openPath(appInfo?.dataPath, '数据目录')} disabled={!appInfo?.dataPath}>
                      <FolderOpen className="size-4" />
                    </IconButton>
                  </div>
                </Row>
                                <Row title="引擎目录" hint="MossInfer 构建的安装位置；修改后新下载的引擎落在这里，已安装的版本不受影响。">
                  <div className="flex max-w-[320px] items-center gap-1">
                    <span className="min-w-0 flex-1 truncate text-right font-mono text-caption text-[var(--color-text-tertiary)]">
                      {draft.engineRoot ?? appInfo?.enginePath ?? '默认 <数据目录>/mossinfer'}
                    </span>
                    <Button tone="ghost" onClick={() => void pickEngineRoot()}>选择</Button>
                    <IconButton label="打开引擎目录" onClick={() => void openPath(draft.engineRoot ?? appInfo?.enginePath, '引擎目录')} disabled={!draft.engineRoot && !appInfo?.enginePath}>
                      <FolderOpen className="size-4" />
                    </IconButton>
                  </div>
                </Row>
<Row title="模型根目录" hint="留空使用默认；修改后模型库会重新扫描。">
                  <div className="flex items-center gap-1">
                    <IconButton label="打开模型目录" onClick={() => void openPath(env?.device.modelsPath, '模型目录')} disabled={!env?.device.modelsPath}>
                      <FolderOpen className="size-4" />
                    </IconButton>
                  </div>
                </Row>
                <Row stacked title="自定义路径">
                  <Input
                    value={draft.modelsRoot ?? ''}
                    placeholder="留空使用默认目录"
                    onChange={(event) => patch({ modelsRoot: event.target.value || null })}
                    className="w-full font-mono text-caption"
                  />
                  <p className="mt-1 break-all font-mono text-caption text-[var(--color-text-tertiary)]">
                    {env?.device.modelsPath ?? '—'}
                  </p>
                </Row>
                <Row title="磁盘剩余" hint="模型目录所在分区。">
                  <span className="font-mono text-ui">{bytes(env?.device.diskFree)}</span>
                </Row>
              </div>
            </Card>

            <Card className="px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[13px] font-semibold">画廊来源</h2>
                <Pill tone="neutral">{draft.galleryRoots.length} 个自定义路径</Pill>
              </div>
              <p className="mt-1 text-ui leading-5 text-[var(--color-text-tertiary)]">
                默认读取应用输出目录；可以添加任意本地文件夹作为画廊来源。
              </p>
              <div className="mt-2.5 space-y-1.5">
                {draft.galleryRoots.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-[var(--color-border)] px-2.5 py-2 text-ui text-[var(--color-text-tertiary)]">
                    使用默认输出目录
                  </div>
                ) : (
                  draft.galleryRoots.map((root) => (
                    <div key={root} className="flex items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-white/[0.03] px-2.5 py-1.5">
                      <FolderOpen className="size-4 shrink-0 text-accent-300" />
                      <span className="min-w-0 flex-1 truncate font-mono text-caption">{root}</span>
                      <IconButton label="移除画廊目录" onClick={() => void removeGalleryRoot(root)} className="text-[var(--color-text-tertiary)] hover:text-red-400">
                        <Trash2 className="size-4" />
                      </IconButton>
                    </div>
                  ))
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button tone="secondary" onClick={() => void addGalleryRoot()}>
                  <span className="inline-flex items-center gap-1.5"><Plus className="size-4" /> 添加文件夹</span>
                </Button>
                <Button tone="ghost" onClick={() => void persist({ galleryRoots: [] })}>恢复默认</Button>
              </div>
            </Card>
          </>
        ) : null}

        {section === 'network' ? (
          <>
            <Card className="px-5 py-4">
              <h2 className="text-[13px] font-semibold">下载策略</h2>
              <div className="mt-2 divide-y divide-[var(--color-border-subtle)]">
                <Row title="策略" hint="自动按延迟选择；镜像失败会回退直连。">
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
                </Row>
                <Row stacked title="当前生效">
                  <div className="rounded-lg bg-[var(--color-surface-secondary)] px-3 py-2 font-mono text-caption leading-5 text-[var(--color-text-secondary)]">
                    <div>git：{selected?.git ?? '直连'}</div>
                    <div>hf：{selected?.hf ?? '直连'}</div>
                    <div>manifest：{selected?.manifest ?? '直连'}</div>
                  </div>
                </Row>
              </div>
            </Card>

            <Card className="px-5 py-4">
              <h2 className="text-[13px] font-semibold">镜像与端点</h2>
              <div className="mt-2 divide-y divide-[var(--color-border-subtle)]">
                <Row stacked title="git 镜像前缀" hint="留空则自动探测；影响引擎安装与 Trainer 仓库拉取。">
                  <Input
                    value={draft.gitMirror ?? ''}
                    placeholder="https://ghproxy.net/"
                    onChange={(event) => patch({ gitMirror: event.target.value || null })}
                    className="w-full font-mono text-caption"
                  />
                </Row>
                <Row stacked title="HF endpoint" hint="下载 MOSS-Image 权重时使用；留空走官方。">
                  <Input
                    value={draft.hfEndpoint ?? ''}
                    placeholder="https://hf-mirror.com"
                    onChange={(event) => patch({ hfEndpoint: event.target.value || null })}
                    className="w-full font-mono text-caption"
                  />
                </Row>
                <Row title="GitHub Token" hint="下载 MossInfer 的 CI 构件需要（公开仓库同样要求）。">
                  <div className="flex items-center gap-1">
                    <Pill tone={settings?.githubToken ? 'accent' : 'neutral'}>{settings?.githubToken ? '已配置' : '未配置'}</Pill>
                    <Button tone="ghost" onClick={() => navigate('/engines')}>去引擎页</Button>
                  </div>
                </Row>
              </div>
            </Card>
          </>
        ) : null}

        {section === 'alerts' ? (
          <>
            <Card className="px-5 py-4">
              <h2 className="text-[13px] font-semibold">通知</h2>
              <div className="mt-2 divide-y divide-[var(--color-border-subtle)]">
                <Row title="桌面通知" hint="任务完成/失败、发现新版本时发送系统通知。">
                  <div className="flex items-center gap-2">
                    <Button tone="ghost" onClick={() => void testNotification()} disabled={!draft.desktopNotifications}>测试</Button>
                    <Switch aria-label="桌面通知" checked={draft.desktopNotifications} onCheckedChange={(value: boolean) => patch({ desktopNotifications: value })} />
                  </div>
                </Row>
                <Row title="启动时检查更新" hint="读取 GitHub Release；开发模式优先本地 release/。">
                  <Switch aria-label="启动时检查更新" checked={draft.autoCheckUpdates} onCheckedChange={(value: boolean) => patch({ autoCheckUpdates: value })} />
                </Row>
              </div>
            </Card>

            <Card className="px-5 py-4">
              <h2 className="text-[13px] font-semibold">版本</h2>
              <div className="mt-2 divide-y divide-[var(--color-border-subtle)]">
                <Row title="更新通道" hint="Beta 读取 beta pinned 资产；缺失时回退 stable。">
                  <Select value={draft.updateChannel} onChange={(event) => patch({ updateChannel: event.target.value as Settings['updateChannel'] })} className="w-[120px]">
                    <option value="stable">稳定版</option>
                    <option value="beta">Beta</option>
                  </Select>
                </Row>
                <Row title="当前版本" hint={updates?.latestVersion && updates.latestVersion !== (appInfo?.version ?? env?.appVersion) ? `最新 ${updates.latestVersion}` : undefined}>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-ui">{appInfo?.version ?? env?.appVersion ?? '0.1.0'}</span>
                    <Button tone="secondary" onClick={() => void checkUpdates()}>
                      <span className="inline-flex items-center gap-1.5"><RefreshCw className="size-4" /> 检查更新</span>
                    </Button>
                  </div>
                </Row>
              </div>
            </Card>
          </>
        ) : null}

        {section === 'lan' ? (
          <Card className="px-5 py-4">
            <h2 className="text-[13px] font-semibold">局域网 WebUI</h2>
            <p className="mt-1 text-ui leading-5 text-[var(--color-text-tertiary)]">
              同一 Wi-Fi 下用手机浏览器打开 Studio；服务只监听本机与设置允许的地址，访问需要 token。
            </p>
            <div className="mt-2 divide-y divide-[var(--color-border-subtle)]">
              <Row title="启用" hint="默认关闭；开启后会启动本地 HTTP/WS 服务。">
                <Switch aria-label="局域网 WebUI" checked={draft.lanWebEnabled} onCheckedChange={(value: boolean) => patch({ lanWebEnabled: value })} />
              </Row>
              <Row title="端口" hint="留空自动分配；修改后保存生效。">
                <Input
                  type="number"
                  min={1024}
                  max={65535}
                  value={draft.lanWebPort ?? ''}
                  placeholder="自动"
                  onChange={(event) => patch({ lanWebPort: event.target.value ? Number(event.target.value) : null })}
                  className="w-[110px] font-mono"
                />
              </Row>
              <Row stacked title="访问地址" hint={draft.lanWebEnabled ? undefined : '保存并启用后才会生成地址。'}>
                <div className="rounded-[5px] border border-[var(--color-border-subtle)] bg-white/[0.025] p-2.5">
                  {(webAccess?.urls ?? []).length === 0 ? (
                    <div className="text-caption text-[var(--color-text-tertiary)]">{webAccess?.error ?? '尚无可用地址'}</div>
                  ) : (
                    (webAccess?.urls ?? []).map((url) => (
                      <div key={url} className="flex items-center gap-2 py-0.5">
                        <code className="min-w-0 flex-1 truncate text-caption text-[var(--color-text-secondary)]">{url}</code>
                        <button type="button" className="shrink-0 text-caption text-accent-300 hover:underline" onClick={() => void copyText(url, '地址已复制')}>复制</button>
                      </div>
                    ))
                  )}
                </div>
              </Row>
            </div>
          </Card>
        ) : null}

        {section === 'devices' ? (
          <Card className="px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[13px] font-semibold">设备</h2>
              <Button tone="ghost" onClick={() => void refreshDevices()}>
                <span className="inline-flex items-center gap-1.5"><RefreshCw className="size-4" /> 重新检测</span>
              </Button>
            </div>
            <p className="mt-1 text-ui leading-5 text-[var(--color-text-tertiary)]">
              禁用的设备不再出现在创作页的设备选择里。每个设备同一时间只跑一个推理任务。
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
        ) : null}

        {section === 'tools' ? (
          <>
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.07] px-3 py-2.5 text-ui leading-5 text-amber-200">
              MossInfer 推理不需要 Python / PyTorch。这里的配置只影响 <span className="font-medium">Trainer</span> 与 <span className="font-medium">GBC</span> 这两个外部工具。
            </div>
            <Card className="px-5 py-4">
              <h2 className="text-[13px] font-semibold">Python 与 PyTorch</h2>
              <div className="mt-2 divide-y divide-[var(--color-border-subtle)]">
                <Row stacked title="Python 解释器" hint="留空自动发现；Trainer 与 GBC 共用。">
                  <Input
                    value={draft.pythonPath ?? ''}
                    placeholder="留空自动发现"
                    onChange={(event) => patch({ pythonPath: event.target.value || null })}
                    className="w-full font-mono text-caption"
                  />
                  <div className="mt-2 rounded-lg bg-[var(--color-surface-secondary)] px-3 py-2">
                    {env?.pythons.length ? (
                      <div className="space-y-0.5">
                        {env.pythons.map((python) => (
                          <div key={python.path} className="flex items-center justify-between gap-2">
                            <span className="font-mono text-ui">{python.version}</span>
                            <span className="truncate text-caption text-[var(--color-text-tertiary)]">{python.source} · {python.path}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-ui text-[var(--color-text-tertiary)]">未发现 Python 3.10+</span>
                    )}
                  </div>
                </Row>
                <Row title="PyTorch 安装" hint="Trainer 环境安装时使用。">
                  <Select
                    value={draft.torchBackend}
                    onChange={(event) => patch({ torchBackend: event.target.value as Settings['torchBackend'] })}
                    className="w-[168px]"
                    options={[
                      { value: 'auto', label: '自动（有 NVIDIA 用 CUDA）' },
                      { value: 'cpu', label: 'CPU' },
                      { value: 'cuda', label: 'CUDA' },
                    ]}
                  />
                </Row>
                <Row stacked title="PyTorch 索引" hint="可选；留空按上面策略推导。">
                  <Input
                    value={draft.torchIndex ?? ''}
                    placeholder="https://download.pytorch.org/whl/cu128"
                    onChange={(event) => patch({ torchIndex: event.target.value || null })}
                    className="w-full font-mono text-caption"
                  />
                </Row>
                <Row stacked title="pip 源" hint="Trainer 环境安装使用（MossInfer 不走 pip）。">
                  <Input
                    value={draft.pipIndex ?? ''}
                    placeholder="https://pypi.org/simple"
                    onChange={(event) => patch({ pipIndex: event.target.value || null })}
                    className="w-full font-mono text-caption"
                  />
                </Row>
                <Row title="训练器根目录" hint={draft.trainerRoot ?? '默认位于应用数据目录的 trainer/'}>
                  <Button tone="secondary" onClick={() => void pickTrainerRoot()}>选择</Button>
                </Row>
              </div>
            </Card>
          </>
        ) : null}

        {section === 'diagnostics' ? (
          <>
            <Card className="px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[13px] font-semibold">环境检查</h2>
                <Button tone="ghost" onClick={() => void refreshEnv()}>
                  <span className="inline-flex items-center gap-1.5"><RefreshCw className="size-4" /> 重新检测</span>
                </Button>
              </div>
              <div className="mt-2.5 space-y-2">
                {(env?.checks ?? []).map((check) => (
                  <div key={check.id} className="flex items-start gap-2.5">
                    <StatusDot status={check.status} className="mt-1.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-ui font-medium">{check.label}</span>
                        <span className="truncate text-right text-ui text-[var(--color-text-secondary)]">{check.value}</span>
                      </div>
                      {check.detail ? <p className="mt-0.5 text-caption leading-4 text-[var(--color-text-tertiary)]">{check.detail}</p> : null}
                    </div>
                  </div>
                ))}
                {!env ? <div className="text-ui text-[var(--color-text-tertiary)]">正在检测…</div> : null}
              </div>
            </Card>

            <Card className="px-5 py-4">
              <h2 className="text-[13px] font-semibold">关于</h2>
              <div className="mt-2 space-y-2 text-ui">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[var(--color-text-tertiary)]">产品</span>
                  <span className="font-semibold">{t('app.name')}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-1.5 text-[var(--color-text-tertiary)]"><Terminal className="size-4" /> 运行时</span>
                  <span className="font-mono text-ui">Electron {appInfo?.electron ?? '—'} · Node {appInfo?.node ?? '—'}</span>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <span className="shrink-0 text-[var(--color-text-tertiary)]">数据目录</span>
                  <span className="break-all text-right font-mono text-caption">{appInfo?.dataPath ?? '—'}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button tone="secondary" onClick={() => void copyDiagnostics()}>
                    <span className="inline-flex items-center gap-1.5"><Copy className="size-4" /> 复制诊断信息</span>
                  </Button>
                  <Button
                    tone="ghost"
                    onClick={() => void call(Ipc.openExternal, { url: 'https://github.com/CloverIris/MossStudio' })}
                  >
                    <span className="inline-flex items-center gap-1.5">项目主页与文档 <ExternalLink className="size-4" /></span>
                  </Button>
                </div>
              </div>
            </Card>
          </>
        ) : null}
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
