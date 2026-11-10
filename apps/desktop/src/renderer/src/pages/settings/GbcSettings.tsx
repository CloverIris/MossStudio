import { Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type { GbcSetupProgress } from '@shared/gbc'
import type { BranchInfo, CommitInfo, GbcVersion, Settings } from '@shared/types'
import { call, onEvent } from '../../lib/api'
import { dateTime } from '../../lib/format'
import { useGbcState } from '../../lib/gbc'
import { useApp } from '../../store'
import { Select } from '../../components/form'
import {
  Advanced,
  Button,
  ConfirmDialog,
  FieldLabel,
  Group,
  IconButton,
  Pill,
  ProgressBar,
  Row,
  Section,
  Spinner,
  useToast,
} from '../../components/ui'
import { errorText, useSaveSettings } from './fields'

const SETUP_STEP: Record<'code' | 'packages', string> = {
  code: '正在下载 KohakuGBC',
  packages: '正在安装 Python 包，第一次要一段时间',
}

const DETECTORS: Array<{ value: Settings['gbcDetector']; label: string }> = [
  { value: 'owlv2', label: 'OWLv2（照片）' },
  { value: 'sam3', label: 'SAM 3（插画）' },
]

/** 设置 › 功能 › 看图拆区域: which model reads the picture, and the KohakuGBC it runs on. */
export function GbcSettings(): React.JSX.Element {
  const settings = useApp((state) => state.settings)!
  const save = useSaveSettings()
  const toast = useToast()
  const gbc = useGbcState(true, settings.gbcVersionId)
  const [setup, setSetup] = useState<GbcSetupProgress | null>(null)
  const installing = setup?.phase === 'code' || setup?.phase === 'packages'

  useEffect(
    () =>
      onEvent<GbcSetupProgress>(Events.gbcSetup, (progress) => {
        setSetup(progress)
        if (progress.phase === 'done') toast.push('看图拆区域可以用了', 'success')
      }),
    [toast],
  )

  async function install(): Promise<void> {
    setSetup({ phase: 'code' })
    try {
      await call(Ipc.gbcSetup)
    } catch (error) {
      setSetup({ phase: 'failed', error: errorText(error) })
    }
  }

  const providerId = gbc.providers.some((provider) => provider.id === settings.gbcProviderId)
    ? settings.gbcProviderId!
    : (gbc.providers[0]?.id ?? '')

  return (
    <Section title="看图拆区域" description="用 KohakuGBC 找出图里的物体，再请助手的模型描述每一个。">
      <Group>
        <Row
          title="看图的模型"
          description={
            gbc.providers.length || gbc.status === undefined
              ? undefined
              : '先在助手里添加一个 OpenAI 兼容或 Anthropic 的模型，并填好 API Key。'
          }
        >
          {gbc.providers.length ? (
            <Select
              aria-label="看图的模型"
              className="w-[260px]"
              value={providerId}
              options={gbc.providers.map((provider) => ({ value: provider.id, label: `${provider.name} · ${provider.model}` }))}
              onValueChange={(value) => void save({ gbcProviderId: value })}
            />
          ) : null}
        </Row>
        <SetupRow
          state={gbc}
          setup={setup}
          installing={installing}
          onInstall={() => void install()}
          onCheck={() => void gbc.refresh(true)}
        />
        <Advanced summary="版本、找物体的方式">
          <GbcAdvanced busy={installing} />
        </Advanced>
      </Group>
    </Section>
  )
}

function SetupRow({
  state,
  setup,
  installing,
  onInstall,
  onCheck,
}: {
  state: ReturnType<typeof useGbcState>
  setup: GbcSetupProgress | null
  installing: boolean
  onInstall: () => void
  onCheck: () => void
}): React.JSX.Element {
  if (installing && setup && (setup.phase === 'code' || setup.phase === 'packages')) {
    return (
      <Row title="运行环境" description={SETUP_STEP[setup.phase]}>
        <ProgressBar value={null} size="md" className="w-[160px]" label={SETUP_STEP[setup.phase]} />
      </Row>
    )
  }
  if (state.status === undefined) {
    return (
      <Row title="运行环境" description="正在检查…">
        <Spinner />
      </Row>
    )
  }
  if (state.status?.available) {
    return (
      <Row title="运行环境" description={state.status.version}>
        <Pill tone="ok">可以用</Pill>
        <Button onClick={onCheck}>检查</Button>
      </Row>
    )
  }
  const failed = setup?.phase === 'failed' ? setup.error : undefined
  return (
    <Row title="运行环境" description={failed ? `没装好：${failed}` : '还没安装'}>
      <Button tone="primary" onClick={onInstall}>
        {failed ? '重试' : '安装'}
      </Button>
    </Row>
  )
}

/** The version 拆成区域 runs, any commit of KohakuGBC, and how objects are found. */
function GbcAdvanced({ busy }: { busy: boolean }): React.JSX.Element {
  const settings = useApp((state) => state.settings)!
  const save = useSaveSettings()
  const toast = useToast()
  const [versions, setVersions] = useState<GbcVersion[]>([])
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const [branch, setBranch] = useState('')
  const [commit, setCommit] = useState('')
  const [working, setWorking] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<GbcVersion | null>(null)

  const loadVersions = async (): Promise<void> => {
    setVersions(await call<GbcVersion[]>(Ipc.gbcVersions).catch(() => []))
  }

  useEffect(() => {
    void loadVersions()
  }, [settings.gbcVersionId])

  async function loadCommits(name: string): Promise<void> {
    const rows = await call<CommitInfo[]>(Ipc.gbcCommits, { branch: name, limit: 80 })
    setCommits(rows)
    setCommit(rows[0]?.sha ?? '')
  }

  async function loadBranches(): Promise<void> {
    setWorking('branches')
    try {
      const rows = await call<BranchInfo[]>(Ipc.gbcBranches)
      setBranches(rows)
      const name = rows.find((item) => item.isDefault)?.name ?? rows[0]?.name ?? 'main'
      setBranch(name)
      await loadCommits(name)
    } catch (error) {
      toast.push(`读取 KohakuGBC 版本失败：${errorText(error)}`, 'error')
    } finally {
      setWorking(null)
    }
  }

  async function addVersion(): Promise<void> {
    if (!branch || !commit) return
    setWorking('create')
    try {
      const version = await call<GbcVersion>(Ipc.gbcVersionCreate, { branch, commit })
      // The version just chosen is the one to use; 安装 above then prepares it.
      await save({ gbcVersionId: version.id })
      await loadVersions()
    } catch (error) {
      toast.push(`添加版本失败：${errorText(error)}`, 'error')
    } finally {
      setWorking(null)
    }
  }

  async function removeVersion(version: GbcVersion): Promise<void> {
    setRemoveTarget(null)
    setWorking(version.id)
    try {
      await call(Ipc.gbcVersionRemove, { id: version.id })
      await loadVersions()
    } catch (error) {
      toast.push(`删除版本失败：${errorText(error)}`, 'error')
    } finally {
      setWorking(null)
    }
  }

  return (
    <div className="flex flex-col gap-0.5">
      <Row title="找物体的方式">
        <Select
          aria-label="找物体的方式"
          className="w-[200px]"
          value={settings.gbcDetector}
          options={DETECTORS}
          onValueChange={(value) => void save({ gbcDetector: value as Settings['gbcDetector'] })}
        />
      </Row>

      <FieldLabel as="h3" className="px-3.5 pb-1 pt-3">
        版本
      </FieldLabel>
      {versions.length === 0 ? <p className="px-3.5 pb-2 text-caption text-ink-2">还没有版本，安装时会用最新的。</p> : null}
      {versions.map((version) => {
        const current = version.id === settings.gbcVersionId
        return (
          <Row
            key={version.id}
            title={`${version.shortCommit} · ${version.subject}`}
            description={`${version.branch} · ${dateTime(version.commitDate)}`}
          >
            {current ? (
              <Pill tone="accent">正在使用</Pill>
            ) : (
              <Button disabled={busy || working !== null} onClick={() => void save({ gbcVersionId: version.id })}>
                用这个
              </Button>
            )}
            <IconButton
              label={`删除版本 ${version.shortCommit}`}
              disabled={busy || working !== null}
              onClick={() => setRemoveTarget(version)}
            >
              {working === version.id ? <Spinner /> : <Trash2 className="size-4" strokeWidth={1.6} />}
            </IconButton>
          </Row>
        )
      })}

      <div className="flex flex-wrap items-center gap-2 px-3.5 pb-3 pt-2">
        {branches.length === 0 ? (
          <Button onClick={() => void loadBranches()} disabled={busy || working !== null}>
            {working === 'branches' ? <Spinner /> : null}
            添加指定版本…
          </Button>
        ) : (
          <>
            <Select
              aria-label="分支"
              className="w-[140px]"
              value={branch}
              onValueChange={(name) => {
                setBranch(name)
                void loadCommits(name).catch((error: unknown) => toast.push(`读取提交失败：${errorText(error)}`, 'error'))
              }}
              options={branches.map((item) => ({ value: item.name, label: item.name }))}
            />
            <Select
              aria-label="提交"
              className="min-w-0 flex-1"
              value={commit}
              onValueChange={setCommit}
              options={
                commits.length
                  ? commits.map((item) => ({ value: item.sha, label: `${item.short} · ${item.subject.slice(0, 60)}` }))
                  : [{ value: '', label: '这个分支没有提交' }]
              }
            />
            <Button onClick={() => void addVersion()} disabled={!commit || busy || working !== null}>
              {working === 'create' ? <Spinner /> : null}
              添加
            </Button>
          </>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        title="删除这个 KohakuGBC 版本？"
        description={removeTarget ? `${removeTarget.shortCommit} 的代码和 Python 环境会被删除。` : ''}
        confirmLabel="删除"
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => removeTarget && void removeVersion(removeTarget)}
      />
    </div>
  )
}
