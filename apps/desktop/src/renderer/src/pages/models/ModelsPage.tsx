import { Download, FolderOpen, Package, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Events, Ipc } from '@shared/channels'
import type { AppInfo, Catalog, ModelBundle } from '@shared/types'
import { call, onEvent } from '../../lib/api'
import { DownloadQueue } from '../../components/DownloadQueue'
import {
  Advanced,
  Button,
  EmptyState,
  Group,
  IconButton,
  PageHeader,
  PageScroll,
  Row,
  Section,
  Segmented,
  Select,
  Spinner,
  Tabs,
  useToast,
} from '../../components/ui'
import { useApp } from '../../store'
import { AdvancedPanel } from './AdvancedPanel'
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
    call<AppInfo>(Ipc.appInfo).then((info) => setModelsPath(info.modelsPath)).catch(() => undefined)
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
      <Row title="模型保存在" description={modelsPath ?? settings?.modelsRoot ?? '应用数据目录'}>
        {modelsPath ? (
          <IconButton
            label="打开模型文件夹"
            onClick={() => void call(Ipc.openPath, { path: modelsPath }).catch((cause: unknown) => toast.push(cause instanceof Error ? cause.message : String(cause), 'error'))}
          >
            <FolderOpen className="size-4" strokeWidth={1.6} />
          </IconButton>
        ) : null}
        <Button tone="ghost" onClick={() => navigate('/settings/storage')}>在 设置 › 存储 中更改</Button>
      </Row>
    </Group>
  )
}

function ModelsTab({
  catalog,
  location,
  preferredBundleId,
  componentFocus,
}: {
  catalog: Catalog
  location: ModelLocation
  preferredBundleId: string | null
  componentFocus: boolean
}): React.JSX.Element {
  const [deleting, setDeleting] = useState<ModelBundle | null>(null)
  const featured = recommendedBundle(catalog.bundles, preferredBundleId)
  const views = useMemo(
    () => catalog.bundles.map((bundle) => bundleView(bundle, catalog.models, location.tasks, location.isModelInstalled)),
    [catalog, location.tasks, location.isModelInstalled],
  )
  const deletePlan = (bundle: ModelBundle) =>
    bundleDeletePlan(bundle, catalog.bundles, catalog.models, location.isModelInstalled, location.tasks)
  const featuredView = views.find((view) => view.bundle.id === featured?.id)
  const others = views.filter((view) => view.bundle.id !== featured?.id && view.status !== 'unavailable')
  // Scanned local files only make sense on this computer.
  const shownOthers = location.kind === 'remote' ? others.filter((view) => view.bundle.id !== 'local-files') : others
  const deletable = (bundle: ModelBundle): boolean => deletePlan(bundle).ids.length > 0

  return (
    <div className="flex flex-col gap-8">
      {location.kind === 'remote' && location.scanError ? (
        <Group>
          <Row title={`读不到 ${location.host?.name ?? '远程主机'} 上的模型`} description={`${location.scanError}。检查这台主机是否在线，然后重试。`}>
            <Button tone="secondary" onClick={location.rescan}>重试</Button>
          </Row>
        </Group>
      ) : null}

      {!location.ready ? (
        location.scanning ? (
          <div className="flex items-center gap-2 px-1 text-ui text-ink-2"><Spinner /> 正在查看 {location.host?.name} 上已有的模型</div>
        ) : null
      ) : featuredView ? (
        <FeaturedModel view={featuredView} location={location} deletable={deletable(featuredView.bundle)} onDelete={setDeleting} />
      ) : (
        <EmptyState
          icon={<Package className="size-8" strokeWidth={1.6} />}
          title="还没有可用的模型列表"
          description="刷新一下；如果仍然为空，检查网络后再试。"
        />
      )}

      {shownOthers.length && location.ready ? (
        <Section title="其他模型">
          <ModelList views={shownOthers} location={location} highlightId={preferredBundleId} deletable={deletable} onDelete={setDeleting} />
        </Section>
      ) : null}

      <Section title="存储位置">
        <StorageRow location={location} />
      </Section>

      <Advanced
        key={componentFocus ? 'open' : 'closed'}
        defaultOpen={componentFocus}
        summary={location.kind === 'local' ? '单独下载部件、指定文件夹、使用电脑上已有的模型文件' : '单独下载部件、主机上的模型文件夹'}
      >
        {location.ready ? (
          <AdvancedPanel catalog={catalog} location={location} />
        ) : (
          <p className="px-3.5 py-2 text-caption text-ink-2">读到这台主机上的模型后才能管理部件。</p>
        )}
      </Advanced>

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
          <p className="text-caption text-ink-2">关闭 MossStudio 后，{location.host?.name ?? '远程主机'} 上的下载仍会继续，重新连接后显示最新进度。</p>
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
            className="py-12"
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
  const [componentFocus, setComponentFocus] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // Deep links from first run and elsewhere: ?bundle=…&component=…&hostId=…&tab=…
  useEffect(() => {
    const query = parseModelsQuery(routeLocation.search)
    if (query.bundleId) setPreferredBundleId(query.bundleId)
    if (query.tab) setTab(query.tab)
    else if (query.bundleId || query.component) setTab('models')
    setComponentFocus(Boolean(query.component && query.component !== 'all' && query.component !== 'adapter'))
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
        <Select aria-label="模型所在的电脑" value={host ? host.id : 'local'} options={locationOptions} onValueChange={setLocationId} className="w-48" />
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
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : tab === 'models' ? (
        <ModelsTab catalog={catalog} location={location} preferredBundleId={preferredBundleId} componentFocus={componentFocus} />
      ) : tab === 'lora' ? (
        <LoraTab catalog={catalog} location={location} />
      ) : (
        <DownloadsTab location={location} />
      )}
    </PageScroll>
  )
}
