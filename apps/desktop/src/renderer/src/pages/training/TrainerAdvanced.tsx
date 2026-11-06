import { FolderOpen, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Ipc } from '@shared/channels'
import type { BranchInfo, CommitInfo, Settings, TrainerVersion } from '@shared/types'
import { call } from '../../lib/api'
import { dateTime } from '../../lib/format'
import { useApp } from '../../store'
import { Button, ConfirmDialog, FieldLabel, IconButton, Pill, Row, Select, Spinner, useToast } from '../../components/ui'
import { TextSetting } from './TextSetting'
import { RUNTIME_LABEL, defaultBranch, optionalUrlError, versionsAt } from './trainerSetup'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const TORCH_OPTIONS: Array<{ value: Settings['torchBackend']; label: string }> = [
  { value: 'auto', label: '自动（有 NVIDIA 显卡时用 CUDA）' },
  { value: 'cuda', label: 'CUDA' },
  { value: 'cpu', label: 'CPU' },
]

/** Everything about the trainer that the app normally decides on its own. */
export function TrainerAdvanced({
  hostId,
  versions,
  busy,
  onChanged,
}: {
  hostId: string
  versions: TrainerVersion[]
  busy: boolean
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const toast = useToast()
  const settings = useApp((state) => state.settings)
  const env = useApp((state) => state.env)
  const saveSettings = useApp((state) => state.saveSettings)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const [branch, setBranch] = useState('')
  const [commit, setCommit] = useState('')
  const [working, setWorking] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<TrainerVersion | null>(null)
  const local = hostId === 'local'
  const here = versionsAt(versions, hostId)

  async function save(patch: Partial<Settings>): Promise<void> {
    try {
      await saveSettings(patch)
    } catch (error) {
      toast.push(`保存失败：${errorText(error)}`, 'error')
      throw error
    }
  }

  async function pickTrainerRoot(): Promise<void> {
    const path = await call<string | null>(Ipc.pickDialog, { kind: 'folder', title: '选择训练器目录' }).catch(() => null)
    if (path) await save({ trainerRoot: path }).catch(() => undefined)
  }

  async function loadCommits(name: string): Promise<void> {
    const rows = local
      ? await call<CommitInfo[]>(Ipc.trainerCommits, { branch: name, limit: 80 })
      : await call<CommitInfo[]>(Ipc.trainerRemoteCommits, { hostId, branch: name, limit: 80 })
    setCommits(rows)
    setCommit(rows[0]?.sha ?? '')
  }

  async function loadBranches(): Promise<void> {
    setWorking('branches')
    try {
      const rows = local ? await call<BranchInfo[]>(Ipc.trainerBranches) : await call<BranchInfo[]>(Ipc.trainerRemoteBranches, { hostId })
      setBranches(rows)
      const name = defaultBranch(rows)
      setBranch(name)
      await loadCommits(name)
    } catch (error) {
      toast.push(`读取训练器版本失败：${errorText(error)}`, 'error')
    } finally {
      setWorking(null)
    }
  }

  async function createVersion(): Promise<void> {
    if (!branch || !commit) return
    setWorking('create')
    try {
      const version = local
        ? await call<TrainerVersion>(Ipc.trainerCreate, { branch, commit })
        : await call<TrainerVersion>(Ipc.trainerRemoteCreate, { hostId, branch, commit })
      toast.push(`已添加版本 ${version.shortCommit}，可在上方安装环境`, 'success')
      await onChanged()
    } catch (error) {
      toast.push(`添加版本失败：${errorText(error)}`, 'error')
    } finally {
      setWorking(null)
    }
  }

  async function removeVersion(version: TrainerVersion): Promise<void> {
    setRemoveTarget(null)
    setWorking(version.id)
    try {
      if (local) await call(Ipc.trainerRemove, { id: version.id })
      else await call(Ipc.trainerRemoteRemove, { hostId, versionId: version.id })
      toast.push(`已删除版本 ${version.shortCommit}`, 'success')
      await onChanged()
    } catch (error) {
      toast.push(`删除版本失败：${errorText(error)}`, 'error')
    } finally {
      setWorking(null)
    }
  }

  return (
    <div className="flex flex-col gap-0.5">
      <Row
        title="Python"
        description={
          env?.pythons.length
            ? `已找到：${env.pythons.map((python) => python.version).join('、')}`
            : '留空时自动查找本机的 Python 3.10 或更新版本'
        }
      >
        <TextSetting
          label="Python 路径"
          className="w-[280px]"
          value={settings?.pythonPath ?? null}
          placeholder="自动查找"
          onSave={(pythonPath) => save({ pythonPath })}
        />
      </Row>
      <Row title="PyTorch" description="安装训练环境时使用的 PyTorch 版本">
        <Select
          aria-label="PyTorch"
          className="w-[280px]"
          value={settings?.torchBackend ?? 'auto'}
          options={TORCH_OPTIONS}
          onValueChange={(value) => void save({ torchBackend: value as Settings['torchBackend'] }).catch(() => undefined)}
        />
      </Row>
      <Row title="PyTorch 源" description="留空时按上面的选择自动决定">
        <TextSetting
          label="PyTorch 源"
          className="w-[280px]"
          value={settings?.torchIndex ?? null}
          placeholder="https://download.pytorch.org/whl/cu128"
          validate={optionalUrlError}
          onSave={(torchIndex) => save({ torchIndex })}
        />
      </Row>
      <Row title="pip 源" description="安装训练环境时下载 Python 包的地址">
        <TextSetting
          label="pip 源"
          className="w-[280px]"
          value={settings?.pipIndex ?? null}
          placeholder="https://pypi.org/simple"
          validate={optionalUrlError}
          onSave={(pipIndex) => save({ pipIndex })}
        />
      </Row>
      <Row title="训练器目录" description={settings?.trainerRoot ?? '默认放在应用数据目录的 trainer 文件夹'}>
        {settings?.trainerRoot ? (
          <Button tone="ghost" onClick={() => void save({ trainerRoot: null }).catch(() => undefined)}>
            恢复默认
          </Button>
        ) : null}
        <Button onClick={() => void pickTrainerRoot()}>
          <FolderOpen className="size-4" strokeWidth={1.6} aria-hidden="true" />
          选择
        </Button>
      </Row>

      <FieldLabel as="h3" className="px-3.5 pb-1 pt-3">
        {local ? '本机的版本' : '这台主机上的版本'}
      </FieldLabel>
      {here.length === 0 ? (
        <p className="px-3.5 pb-2 text-caption text-ink-2">还没有版本。</p>
      ) : (
        here.map((version) => (
          <Row
            key={version.id}
            title={`${version.shortCommit} · ${version.subject}`}
            description={`${version.branch} · ${dateTime(version.commitDate)}`}
          >
            <Pill tone={version.runtimeState === 'ready' ? 'ok' : version.runtimeState === 'error' ? 'danger' : 'neutral'}>
              {RUNTIME_LABEL[version.runtimeState]}
            </Pill>
            <IconButton
              label={`删除版本 ${version.shortCommit}`}
              disabled={busy || working !== null}
              onClick={() => setRemoveTarget(version)}
            >
              {working === version.id ? <Spinner /> : <Trash2 className="size-4" strokeWidth={1.6} />}
            </IconButton>
          </Row>
        ))
      )}

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
            <Button onClick={() => void createVersion()} disabled={!commit || busy || working !== null}>
              {working === 'create' ? <Spinner /> : null}
              添加
            </Button>
          </>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        title="删除这个训练器版本？"
        description={removeTarget ? `${removeTarget.shortCommit} 的文件和环境会被删除，训练记录和训练出的 LoRA 不受影响。` : ''}
        confirmLabel="删除"
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => removeTarget && void removeVersion(removeTarget)}
      />
    </div>
  )
}
