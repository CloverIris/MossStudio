import { Download, FolderOpen, Package, Plus, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Events, Ipc } from '@shared/channels'
import type { SlotKey } from '@shared/modelCombos'
import type { AppInfo, Catalog, ModelBundle } from '@shared/types'
import { importFolderMessage, type UseFolderResult } from '../../lib/modelFolder'
import { call, onEvent } from '../../lib/api'
import { DownloadQueue } from '../../components/DownloadQueue'
import { MenuItem, Popover } from '../../components/common/Popover'
import { Notice } from '../../components/common/Notice'
import {
  Advanced,
  Button,
  EmptyState,
  Group,
  IconButton,
  LoadingRow,
  PageHeader,
  PageScroll,
  Row,
  Section,
  Segmented,
  Select,
  Tabs,
  useToast,
} from '../../components/ui'
import { useApp } from '../../store'
import { AdvancedPanel } from './AdvancedPanel'
import { CombinationDialog } from './CombinationDialog'
import { ControlAdaptersSection } from './ControlAdaptersSection'
import { LoraTab } from './LoraTab'
import { DeleteModelDialog, FeaturedModel, ModelList } from './ModelEntries'
import { bundleDeletePlan, bundleView, parseModelsQuery, recommendedBundle, visibleTasks } from './logic'
import { useModelLocation, useSshHosts, type ModelLocation } from './useModelLocation'

type Tab = 'models' | 'lora' | 'downloads'

function StorageRow({ location }: { location: ModelLocation }): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const settings = useApp((state) => state.settings)
  const [modelsPath, setModelsPath] = useState<string | null>(null)
  useEffect(() => {
    if (location.kind !== 'local') return
    call<AppInfo>(Ipc.appInfo)
      .then((info) => setModelsPath(info.modelsPath))
      .catch(() => undefined)
  }, [location.kind, settings?.modelsRoot])

  if (location.kind === 'remote') {
    const root = location.inventory?.root ?? location.host?.modelsRoot ?? '~/.mossstudio/models'
    return (
      <Group>
        <Row title={`模型保存在 ${location.host?.name ?? '远程主机'} 上`} description={root} />
      </Group>
    )
  }
  return (
    <Group>
      <Row title="模型文件夹" description={modelsPath ?? settings?.modelsRoot ?? '应用数据目录'}>
        {modelsPath ? (
          <IconButton
            label="打开模型文件夹"
            onClick={() =>
              void call(Ipc.openPath, { path: modelsPath }).catch((cause: unknown) =>
                toast.push(cause instanceof Error ? cause.message : String(cause), 'error'),
              )
            }
          >
            <FolderOpen className="size-4" strokeWidth={1.6} />
          </IconButton>
        ) : null}
        <Button tone="ghost" onClick={() => navigate('/settings/storage')}>
          在 设置 › 存储 中更改
        </Button>
      </Row>
    </Group>
  )
}

function ModelsTab({
  catalog,
  location,
  preferredBundleId,
}: {
  catalog: Catalog
  location: ModelLocation
  preferredBundleId: string | null
}): React.JSX.Element {
  const toast = useToast()
  const [deleting, setDeleting] = useState<ModelBundle | null>(null)
  const [combining, setCombining] = useState<{ initial?: Partial<Record<SlotKey, string | null>> } | null>(null)
  const featured = recommendedBundle(catalog.bundles, preferredBundleId)
  const views = useMemo(
    () => catalog.bundles.map((bundle) => bundleView(bundle, catalog.models, location.tasks, location.isModelInstalled)),
    [catalog, location.tasks, location.isModelInstalled],
  )
  const deletePlan = (bundle: ModelBundle) =>
    bundleDeletePlan(bundle, catalog.bundles, catalog.models, location.isModelInstalled, location.tasks)
  const featuredView = views.find((view) => view.bundle.id === featured?.id)
  const others = views.filter((view) => view.bundle.id !== featured?.id && view.status !== 'unavailable')
  // Combinations are built and run on this computer.
  const shownOthers = location.kind === 'remote' ? others.filter((view) => !view.bundle.custom) : others
  const deletable = (bundle: ModelBundle): boolean => Boolean(bundle.custom) || deletePlan(bundle).ids.length > 0

  async function addFromFolder(): Promise<void> {
    try {
      const result = await call<UseFolderResult>(Ipc.modelsUseFolder)
      if (result.canceled) return
      if (result.folders?.length) {
        toast.push(importFolderMessage(result), 'success')
        return
      }
      if (!result.slots) {
        toast.push('这个文件夹里没有找到主模型、文本编码器或 VAE', 'info')
        return
      }
      setCombining({ initial: result.slots })
    } catch (cause) {
      toast.push(cause instanceof Error ? cause.message : String(cause), 'error')
    }
  }

  const combine =
    location.kind === 'local' ? (
      <Popover
        align="end"
        label="自己组合"
        trigger={(menu) => (
          <Button tone="ghost" onClick={menu.toggle} aria-expanded={menu['aria-expanded']} aria-haspopup="menu">
            <Plus className="size-4" strokeWidth={1.6} />
            自己组合
          </Button>
        )}
      >
        {(close) => (
          <>
            <MenuItem
              onSelect={() => {
                close()
                setCombining({})
              }}
            >
              挑选要下载的部件
            </MenuItem>
            <MenuItem
              onSelect={() => {
                close()
                void addFromFolder()
              }}
            >
              用电脑上的模型文件…
            </MenuItem>
          </>
        )}
      </Popover>
    ) : null

  return (
    <div className="flex flex-col gap-8">
      {location.kind === 'remote' && location.scanError ? (
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={location.rescan}>
              重试
            </Button>
          }
        >
          读不到 {location.host?.name ?? '远程主机'} 上的模型：{location.scanError}。检查这台主机是否在线，然后重试。
        </Notice>
      ) : null}

      {!location.ready ? (
        location.scanning ? (
          <LoadingRow label={`正在查看 ${location.host?.name ?? '远程主机'} 上的模型…`} />
        ) : null
      ) : featuredView ? (
        <FeaturedModel view={featuredView} location={location} deletable={deletable(featuredView.bundle)} onDelete={setDeleting} />
      ) : (
        <Group>
          <EmptyState
            size="section"
            icon={<Package className="size-6" strokeWidth={1.6} />}
            title="还没有可用的模型列表"
            description="刷新一下；如果仍然为空，检查网络后再试。"
          />
        </Group>
      )}

      {location.ready && (shownOthers.length || combine) ? (
        <Section title="其他模型" actions={combine}>
          {shownOthers.length ? (
            <ModelList
              views={shownOthers}
              location={location}
              highlightId={preferredBundleId}
              deletable={deletable}
              onDelete={setDeleting}
            />
          ) : null}
        </Section>
      ) : null}

      {location.kind === 'local' ? <ControlAdaptersSection /> : null}

      <Section title="存储位置">
        <StorageRow location={location} />
      </Section>

      <Advanced summary={location.kind === 'local' ? '各部件的文件夹、没有用到的文件' : '主机上的模型文件夹'}>
        {location.ready ? (
          <AdvancedPanel catalog={catalog} location={location} />
        ) : (
          <p className="px-3.5 py-2 text-caption text-ink-2">读到这台主机上的模型后才能管理部件。</p>
        )}
      </Advanced>

      {combining ? (
        <CombinationDialog open catalog={catalog} location={location} initial={combining.initial} onClose={() => setCombining(null)} />
      ) : null}

      <DeleteModelDialog
        bundle={deleting}
        bundles={catalog.bundles}
        models={catalog.models}
        location={location}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}

function DownloadsTab({ location }: { location: ModelLocation }): React.JSX.Element {
  const tasks = visibleTasks(location.tasks)
  return (
    <div className="flex flex-col gap-3">
      {location.kind === 'remote' ? (
        <div className="flex items-center justify-between gap-4 px-1">
          <p className="text-caption text-ink-2">
            关闭 MossStudio 后，{location.host?.name ?? '远程主机'} 上的下载仍会继续，重新连接后显示最新进度。
          </p>
          <IconButton
            label="刷新下载进度"
            onClick={() => location.host && void call(Ipc.remoteDownloadsRefresh, { hostId: location.host.id }).catch(() => undefined)}
          >
            <RefreshCw className="size-4" strokeWidth={1.6} />
          </IconButton>
        </div>
      ) : null}
      {tasks.length ? (
        <DownloadQueue tasks={tasks} onPause={location.pause} onResume={location.resume} onCancel={location.cancel} />
      ) : (
        <Group>
          <EmptyState
            size="section"
            icon={<Download className="size-6" strokeWidth={1.6} />}
            title="没有进行中的下载"
            description="开始下载模型或 LoRA 后，进度会显示在这里。"
          />
        </Group>
      )}
    </div>
  )
}

/** 模型: whole models first, LoRA and downloads in their own tabs, parts under 高级. */
export function ModelsPage(): React.JSX.Element {
  const routeLocation = useLocation()
  const catalog = useApp((state) => state.catalog)
  const settings = useApp((state) => state.settings)
  const refreshCatalog = useApp((state) => state.refreshCatalog)
  const remoteEnabled = Boolean(settings?.remoteHostsEnabled)
  const hosts = useSshHosts(remoteEnabled)
  const [locationId, setLocationId] = useState('local')
  const [tab, setTab] = useState<Tab>('models')
  const [preferredBundleId, setPreferredBundleId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Deep links from first run and elsewhere: ?bundle=…&component=…&hostId=…&tab=…
  useEffect(() => {
    const query = parseModelsQuery(routeLocation.search)
    if (query.bundleId) setPreferredBundleId(query.bundleId)
    if (query.tab) setTab(query.tab)
    else if (query.bundleId || query.component) setTab('models')
    if (query.hostId) setLocationId(query.hostId)
  }, [routeLocation.key, routeLocation.search])

  useEffect(() => {
    void refreshCatalog()
    return onEvent(Events.modelsChanged, () => void refreshCatalog())
  }, [refreshCatalog])

  const host = remoteEnabled ? (hosts.find((item) => item.id === locationId) ?? null) : null
  const location = useModelLocation(host)
  const downloadCount = visibleTasks(location.tasks).length

  const locationOptions = [{ value: 'local', label: '本机' }, ...hosts.map((item) => ({ value: item.id, label: item.name }))]
  const locationPicker =
    remoteEnabled && hosts.length > 0 ? (
      locationOptions.length <= 4 ? (
        <Segmented label="模型所在的电脑" value={host ? host.id : 'local'} options={locationOptions} onChange={setLocationId} />
      ) : (
        <Select
          aria-label="模型所在的电脑"
          value={host ? host.id : 'local'}
          options={locationOptions}
          onValueChange={setLocationId}
          className="w-48"
        />
      )
    ) : null

  async function refresh(): Promise<void> {
    setRefreshing(true)
    try {
      await refreshCatalog()
      location.rescan()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <PageScroll>
      <PageHeader
        title="模型"
        description="下载用来生成图片的模型和 LoRA。"
        actions={
          <>
            {locationPicker}
            <IconButton label="刷新" disabled={refreshing} onClick={() => void refresh()}>
              <RefreshCw className={refreshing ? 'size-4 animate-spin' : 'size-4'} strokeWidth={1.6} />
            </IconButton>
          </>
        }
      />

      <Tabs
        label="模型页面"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'models', label: '模型' },
          { value: 'lora', label: 'LoRA' },
          { value: 'downloads', label: '下载', count: downloadCount },
        ]}
      />

      {!catalog ? (
        <LoadingRow label="正在读取模型列表…" />
      ) : tab === 'models' ? (
        <ModelsTab catalog={catalog} location={location} preferredBundleId={preferredBundleId} />
      ) : tab === 'lora' ? (
        <LoraTab catalog={catalog} location={location} />
      ) : (
        <DownloadsTab location={location} />
      )}
    </PageScroll>
  )
}
