import { FolderPlus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Ipc } from '@shared/channels'
import { compareEngineTags } from '@shared/engineUpdate'
import { gpuRequiresBf16Tier } from '@shared/gpuProfile'
import type { GpuInventorySnapshot, LocalEngineVersion, Settings } from '@shared/types'
import { call } from '../../lib/api'
import { date } from '../../lib/format'
import { engineDownloadActive, packageLabel } from '../../lib/engineInstall'
import { enginePackageOptionLabel } from '@shared/enginePackages'
import { useApp } from '../../store'
import { Button, ConfirmDialog, IconButton, Pill, Row, Segmented, Select, Spinner, useToast } from '../../components/ui'
import { applyEngineOverride, applyGpuOverride, engineOverrideOptions, fixedEngineSettingsNote, type OverrideField } from './devicesModel'
import { FolderRow, errorText, pickFolder, useSaveSettings } from './fields'
import { useAppInfo } from './useAppInfo'
import type { EngineState, InstallOutcome, LocalInstallOptions } from './useEngine'

const MEMORY_OPTIONS: Array<{ value: Settings['mossInferMemoryMode']; label: string }> = [
  { value: 'min_memory', label: '省显存' },
  { value: 'balanced', label: '均衡' },
  { value: 'max_speed', label: '速度优先' },
]

const TIER_OPTIONS: Array<{ value: Settings['mossInferTier']; label: string }> = [
  { value: 'reference', label: 'Reference' },
  { value: 'high', label: 'High' },
  { value: 'turbo', label: 'Turbo' },
]

/** A small heading inside the Advanced area. */
function SubHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h3 className="px-3.5 pb-1 pt-4 text-caption font-semibold text-ink-2">{children}</h3>
}

export function EngineAdvanced({ engine, inventory }: { engine: EngineState; inventory: GpuInventorySnapshot | null }): React.JSX.Element {
  const settings = useApp((state) => state.settings)!
  const save = useSaveSettings()
  const info = useAppInfo()

  function saveOverride(uuid: string, field: OverrideField, value: string): void {
    void save({ gpuProfileOverrides: applyGpuOverride(settings.gpuProfileOverrides ?? {}, uuid, field, value) })
  }

  return (
    <div className="flex flex-col gap-0.5">
      <SubHeading>性能</SubHeading>
      <Row
        title="显存模式"
        description={
          settings.gpuProfileMode === 'auto'
            ? '现在按每块 GPU 的显存自动选择。手动选择后对所有 GPU 生效。'
            : '省显存更稳，速度优先需要更多显存。'
        }
      >
        {settings.gpuProfileMode === 'custom' ? (
          <Button tone="ghost" onClick={() => void save({ gpuProfileMode: 'auto' })}>
            恢复自动
          </Button>
        ) : null}
        <Segmented
          label="显存模式"
          value={settings.mossInferMemoryMode}
          onChange={(mossInferMemoryMode) => void save({ mossInferMemoryMode, gpuProfileMode: 'custom' })}
          options={MEMORY_OPTIONS}
        />
      </Row>
      <Row
        title="性能档位"
        description="Reference 最精确；High 和 Turbo 更快，需要对应的量化模型。较老的显卡（SM 8.0 以下）总是使用 Reference。"
      >
        <Segmented
          label="性能档位"
          value={settings.mossInferTier}
          onChange={(mossInferTier) => void save({ mossInferTier })}
          options={TIER_OPTIONS}
        />
      </Row>
      {(inventory?.devices ?? []).length > 1 ? (
        <>
          <SubHeading>每块 GPU 单独设置</SubHeading>
          {inventory!.devices.map((device) => {
            const override = settings.gpuProfileOverrides?.[device.uuid]
            const bf16Only = gpuRequiresBf16Tier(device)
            // Vulkan / HIP engines take neither setting: one quiet line instead of the pickers.
            const fixed = fixedEngineSettingsNote(engine.readiness, device.uuid)
            if (fixed) return <Row key={device.uuid} title={device.name} description={fixed} />
            return (
              <Row key={device.uuid} title={device.name} description={bf16Only ? '这块显卡只能使用 Reference 档位' : `GPU ${device.index}`}>
                <Select
                  aria-label={`${device.name} 显存模式`}
                  className="w-32"
                  value={override?.memoryMode ?? 'global'}
                  onValueChange={(value) => saveOverride(device.uuid, 'memoryMode', value)}
                  options={[{ value: 'global', label: '跟随上面' }, ...MEMORY_OPTIONS]}
                />
                <Select
                  aria-label={`${device.name} 性能档位`}
                  className="w-32"
                  disabled={bf16Only}
                  value={bf16Only ? 'reference' : (override?.tier ?? 'global')}
                  onValueChange={(value) => saveOverride(device.uuid, 'tier', value)}
                  options={[{ value: 'global', label: '跟随上面' }, ...TIER_OPTIONS]}
                />
              </Row>
            )
          })}
        </>
      ) : null}

      <GpuEngines engine={engine} />

      <SubHeading>安装方式</SubHeading>
      <InstallOptions engine={engine} />

      <SubHeading>已安装的版本</SubHeading>
      <InstalledVersions engine={engine} />

      <SubHeading>自定义引擎</SubHeading>
      <CustomEngine engine={engine} />

      <FolderRow
        title="引擎目录"
        description="新下载的引擎保存在这里；已安装的版本不会移动。"
        value={settings.engineRoot}
        fallback={info?.enginePath}
        pickTitle="选择引擎目录"
        onChange={(engineRoot) => save({ engineRoot })}
      />
    </div>
  )
}

/** One GPU per row: which engine package it runs; 自动 follows the plan. */
function GpuEngines({ engine }: { engine: EngineState }): React.JSX.Element | null {
  const settings = useApp((state) => state.settings)!
  const save = useSaveSettings()
  const toast = useToast()
  const plan = engine.plan
  const installing = engineDownloadActive(engine.download)
  if (!plan || plan.choices.length === 0) return null
  const overrides = settings.engineDeviceOverrides ?? {}

  async function choose(deviceUuid: string, value: string): Promise<void> {
    await save({ engineDeviceOverrides: applyEngineOverride(overrides, deviceUuid, value) })
  }

  async function installMissing(): Promise<void> {
    const outcome = await engine.install({ channel: settings.mossInferChannel })
    if (outcome.kind === 'failed') toast.push(outcome.message, 'error')
  }

  return (
    <>
      <SubHeading>每块 GPU 的引擎</SubHeading>
      {plan.choices.map((choice) => {
        const options = engineOverrideOptions(plan, choice.gpuId)
        const value =
          overrides[choice.gpuId] && options.some((option) => option.value === overrides[choice.gpuId]) ? overrides[choice.gpuId]! : 'auto'
        const picked = options.find((option) => option.value === value)
        const description = choice.package
          ? `${value === 'auto' ? '自动：' : ''}${enginePackageOptionLabel(choice.package)}${picked?.description ? ` · ${picked.description}` : ''}`
          : choice.reason
        return (
          <Row
            key={choice.gpuId}
            title={choice.gpuName}
            description={choice.overrideIgnored ? `${description} · 之前选的引擎不能用于这块显卡，已改回自动` : description}
          >
            <Select
              aria-label={`${choice.gpuName} 使用的引擎`}
              className="w-56"
              value={value}
              disabled={options.length <= 1}
              onValueChange={(next) => void choose(choice.gpuId, next)}
              options={options.map(({ value: optionValue, label }) => ({ value: optionValue, label }))}
            />
          </Row>
        )
      })}
      {plan.missing.length > 0 ? (
        <Row title="所选引擎还没有安装" description={plan.missing.map((id) => packageLabel(id) ?? id).join('、')}>
          <Button onClick={() => void installMissing()} disabled={installing}>
            安装
          </Button>
        </Row>
      ) : null}
    </>
  )
}

function InstallOptions({ engine }: { engine: EngineState }): React.JSX.Element {
  const settings = useApp((state) => state.settings)!
  const toast = useToast()
  const [channel, setChannel] = useState<LocalInstallOptions['channel']>(settings.mossInferChannel)
  const [releaseTag, setReleaseTag] = useState('')
  const [starting, setStarting] = useState(false)
  const installing = engineDownloadActive(engine.download)
  const { releases, loadReleases } = engine

  useEffect(() => {
    if (channel === 'stable' && releases === null) void loadReleases()
  }, [channel, releases, loadReleases])

  async function run(): Promise<void> {
    setStarting(true)
    // Every GPU's package from this channel / release, side by side with what is installed.
    const outcome: InstallOutcome = await engine.install({ channel, releaseTag: releaseTag || undefined, all: true })
    setStarting(false)
    if (outcome.kind === 'failed') toast.push(outcome.message, 'error')
    const latest = [...(releases ?? [])].sort((a, b) => compareEngineTags(b.tag, a.tag))[0]
    if (outcome.kind === 'started' && channel === 'stable' && releaseTag && latest && compareEngineTags(latest.tag, releaseTag) > 0) {
      toast.push(`装好后会一直使用 ${releaseTag}，自动更新会跳过它。想恢复时在「引擎」里点更新，或把「自动更新」关掉再打开。`, 'info')
    }
  }

  return (
    <>
      <Row
        title="渠道"
        description={channel === 'dev' ? '开发版来自最新的自动构建，需要在 网络 › 高级 填写 GitHub 令牌。' : '正式发布的版本。'}
      >
        <Select
          aria-label="引擎渠道"
          className="w-40"
          value={channel}
          onValueChange={(value) => setChannel(value as LocalInstallOptions['channel'])}
          options={[
            { value: 'stable', label: '正式版' },
            { value: 'dev', label: '开发版' },
          ]}
        />
      </Row>
      {channel === 'stable' ? (
        <Row title="版本" description={engine.releasesError ? `读取版本列表失败：${engine.releasesError}` : '默认安装最新的正式版。'}>
          <IconButton label="刷新版本列表" onClick={() => void loadReleases()} disabled={engine.loadingReleases}>
            <RefreshCw className={engine.loadingReleases ? 'size-4 animate-spin' : 'size-4'} />
          </IconButton>
          <Select
            aria-label="引擎版本"
            className="w-56"
            value={releaseTag}
            onValueChange={setReleaseTag}
            options={[
              { value: '', label: '最新版本' },
              ...(releases ?? []).map((release) => ({
                value: release.tag,
                label: `${release.tag}${release.publishedAt ? ` · ${date(release.publishedAt)}` : ''}`,
              })),
            ]}
          />
        </Row>
      ) : null}
      <Row title="按以上选项安装" description="为每块显卡安装它使用的引擎；成功后切换到新版本，失败时继续使用当前版本。">
        <Button onClick={() => void run()} disabled={starting || installing || Boolean(engine.plan?.blocked)}>
          {starting ? <Spinner /> : null}安装
        </Button>
      </Row>
    </>
  )
}

function InstalledVersions({ engine }: { engine: EngineState }): React.JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [removing, setRemoving] = useState<LocalEngineVersion | null>(null)
  const installing = engineDownloadActive(engine.download)

  async function select(version: LocalEngineVersion): Promise<void> {
    setBusy(version.id)
    try {
      await call(Ipc.engineVersionSelect, { id: version.id })
      toast.push(`已切换到 ${version.name}`, 'success')
      await engine.refreshVersions()
    } catch (error) {
      toast.push(errorText(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function remove(version: LocalEngineVersion): Promise<void> {
    setRemoving(null)
    setBusy(version.id)
    try {
      await call(Ipc.engineVersionRemove, { id: version.id })
      toast.push(`已删除 ${version.name}`, 'success')
      await engine.refreshVersions()
    } catch (error) {
      toast.push(errorText(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {engine.versions.length === 0 ? (
        <Row title="还没有安装引擎" />
      ) : (
        engine.versions.map((version) => (
          <Row
            key={version.id}
            title={<span className="font-mono text-caption">{version.name}</span>}
            description={<span className="font-mono">{version.path}</span>}
          >
            {version.current ? (
              <Pill tone="accent">正在使用</Pill>
            ) : (
              <Button onClick={() => void select(version)} disabled={busy !== null || installing}>
                {busy === version.id ? <Spinner /> : null}使用这个版本
              </Button>
            )}
            <IconButton
              label={version.current ? '正在使用的版本不能删除' : `删除 ${version.name}`}
              disabled={version.current || busy !== null || installing}
              onClick={() => setRemoving(version)}
            >
              <Trash2 className="size-4" />
            </IconButton>
          </Row>
        ))
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        title="删除这个引擎版本？"
        description={
          removing
            ? `${removing.name} 的全部文件会被删除。${removing.source === 'external' ? '自定义引擎只会从列表中移除，文件夹保留。' : ''}`
            : ''
        }
        confirmLabel="删除"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) void remove(removing)
        }}
      />
    </>
  )
}

function CustomEngine({ engine }: { engine: EngineState }): React.JSX.Element {
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  const [tested, setTested] = useState(false)
  const ready = engine.readiness?.state === 'ready'

  async function add(): Promise<void> {
    setAdding(true)
    try {
      const path = await pickFolder('选择包含 moss-server 的引擎文件夹')
      if (!path) return
      await call<LocalEngineVersion[]>(Ipc.engineSelectDirectory, { path })
      await engine.refreshVersions()
      toast.push('已添加。在上面的版本列表里选择「使用这个版本」即可切换', 'success')
    } catch (error) {
      toast.push(`没有添加：${errorText(error)}`, 'error')
    } finally {
      setAdding(false)
    }
  }

  async function test(): Promise<void> {
    const ok = await engine.runProbe()
    setTested(true)
    if (!ok) toast.push('引擎没有响应，详情见下方', 'error')
  }

  const hello = engine.hello
  const compatible = engine.probe?.devices.filter((device) => device.status === 'supported').length ?? 0
  const needsCudaLibs = Boolean(
    engine.readiness?.path?.includes('system-cuda') && hello && (!hello.probe?.cublasLt || hello.probe.cublasLt.error),
  )

  return (
    <>
      <Row
        title="添加自定义引擎"
        description="选择自己编译或第三方提供的 MossInfer 文件夹（包含 bin/moss-server）。添加前会检查它能否正常通信。"
      >
        <Button onClick={() => void add()} disabled={adding}>
          {adding ? <Spinner /> : <FolderPlus className="size-4" />}选择文件夹
        </Button>
      </Row>
      <Row
        title="测试当前引擎"
        description={
          tested || hello || engine.probeError
            ? engine.probeError
              ? `失败：${engine.probeError}`
              : hello
                ? `通信正常 · ${hello.server ?? 'MossInfer'} ${hello.version ?? ''} · 协议 ${hello.protocol} · ${compatible} 块 GPU 可用`
                : '正在测试…'
            : '启动引擎并检查它能使用哪些 GPU。'
        }
      >
        <Button onClick={() => void test()} disabled={!ready || engine.probing}>
          {engine.probing ? <Spinner /> : null}测试
        </Button>
      </Row>
      {needsCudaLibs ? <CudaLibsRow /> : null}
    </>
  )
}

function CudaLibsRow(): React.JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  async function install(): Promise<void> {
    setBusy(true)
    try {
      const result = await call<{ installed: string[] }>(Ipc.mossInferCudaLibs)
      toast.push(`CUDA 运行库已就绪（${result.installed.length} 个文件）`, 'success')
    } catch (error) {
      toast.push(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Row title="当前引擎缺少 CUDA 运行库" description="当前版本依赖系统 CUDA，但没有找到可用的 cuBLASLt。可以下载运行库放到引擎旁边。">
      <Button onClick={() => void install()} disabled={busy}>
        {busy ? <Spinner /> : null}下载运行库
      </Button>
    </Row>
  )
}
