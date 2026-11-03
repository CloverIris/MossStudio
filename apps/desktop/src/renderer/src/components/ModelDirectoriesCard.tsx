import { FolderOpen, FolderSearch, HardDrive, RefreshCw, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type { ModelDirectories, ModelDirectoryId, ModelScanResult, ScannedModel, Settings } from '@shared/types'
import { call, onEvent } from '../lib/api'
import { Button, Card, Modal, Pill, Spinner, cn, useToast } from './ui'

const roles: Array<{ key: ModelDirectoryId; label: string; hint: string }> = [
  { key: 'dit', label: '主模型 DiT', hint: 'diffusers transformer 或 ComfyUI diffusion_models' },
  { key: 'textEncoder', label: '文本编码器', hint: 'Qwen3.5 / ComfyUI text_encoders' },
  { key: 'vae', label: 'VAE', hint: 'FLUX.2 VAE' },
  { key: 'adapters', label: 'LoRA 适配器', hint: 'loras 目录' },
  { key: 'support', label: '运行配置', hint: 'pipeline / scheduler 等辅助文件' },
]

const roleLabel: Record<ScannedModel['role'], string> = {
  dit: '主模型',
  text_encoder: '文本编码器',
  vae: 'VAE',
  support: '运行配置',
  full: 'diffusers 整包',
  lora: 'LoRA',
}

const roleTone: Record<ScannedModel['role'], 'accent' | 'blue' | 'neutral' | 'amber'> = {
  dit: 'accent',
  text_encoder: 'blue',
  vae: 'blue',
  support: 'neutral',
  full: 'neutral',
  lora: 'amber',
}

function bytes(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2).replace(/\.?0+$/, '')} GB`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1).replace(/\.0$/, '')} MB`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} KB`
  return `${value} B`
}

/**
 * Model storage lives on the Models page, where the user runs into it, instead
 * of three levels down in Settings. Selecting a folder only scans it; nothing is
 * copied or created until the user registers a file.
 */
export function ModelDirectoriesCard(): React.JSX.Element {
  const toast = useToast()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [scan, setScan] = useState<ModelScanResult | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'scan' | 'clean' | 'roots' | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setSettings(await call<Settings>(Ipc.settingsGet))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void load()
    return onEvent(Events.settingsChanged, () => void load())
  }, [load])

  const persist = useCallback(
    async (patch: Partial<Settings>): Promise<Settings | null> => {
      setBusy('roots')
      try {
        const next = await call<Settings>(Ipc.settingsUpdate, patch)
        setSettings(next)
        toast.push('模型目录已更新', 'success')
        return next
      } catch (cause) {
        toast.push(cause instanceof Error ? cause.message : String(cause), 'error')
        return null
      } finally {
        setBusy(null)
      }
    },
    [toast],
  )

  const runScan = useCallback(
    async (directory?: string) => {
      setBusy('scan')
      setError(null)
      try {
        const result = await call<ModelScanResult & { canceled?: boolean }>(Ipc.modelsScan, directory ? { directory } : {})
        if (result.canceled) return
        setScan(result)
        const preselect = new Set(
          result.candidates
            .filter((candidate) => candidate.confidence !== 'low' && candidate.role !== 'lora')
            .map((candidate) => candidate.path),
        )
        setSelected(preselect)
        if (!result.candidates.length) toast.push('这个目录里没有找到模型文件', 'info')
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(message)
        toast.push(message, 'error')
      } finally {
        setBusy(null)
      }
    },
    [toast],
  )

  const chooseRoot = useCallback(async () => {
    try {
      const path = await call<string | null>(Ipc.pickDialog, { kind: 'folder', title: '选择模型根目录' })
      if (!path) return
      if (await persist({ modelsRoot: path })) void runScan(path)
    } catch (cause) {
      toast.push(cause instanceof Error ? cause.message : String(cause), 'error')
    }
  }, [persist, runScan, toast])

  const directories: ModelDirectories = settings?.modelDirectories ?? {
    dit: null,
    textEncoder: null,
    vae: null,
    support: null,
    adapters: null,
  }

  const chooseRole = useCallback(
    async (key: ModelDirectoryId) => {
      try {
        const path = await call<string | null>(Ipc.pickDialog, { kind: 'folder', title: '选择目录' })
        if (!path) return
        const next = { ...directories, [key]: path }
        if (await persist({ modelDirectories: next })) void runScan(path)
      } catch (cause) {
        toast.push(cause instanceof Error ? cause.message : String(cause), 'error')
      }
    },
    [directories, persist, runScan, toast],
  )

  const clearRole = useCallback(
    async (key: ModelDirectoryId) => {
      const next = { ...directories, [key]: null }
      await persist({ modelDirectories: next })
    },
    [directories, persist],
  )

  const cleanup = useCallback(async () => {
    setBusy('clean')
    try {
      const result = await call<{ removed: string[] }>(Ipc.modelsCleanupEmpty)
      toast.push(
        result.removed.length ? `已清理 ${result.removed.length} 个空目录` : '没有需要清理的空目录',
        'success',
      )
    } catch (cause) {
      toast.push(cause instanceof Error ? cause.message : String(cause), 'error')
    } finally {
      setBusy(null)
    }
  }, [toast])

  const toggle = (path: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const register = useCallback(async () => {
    if (!scan) return
    const items = scan.candidates
      .filter((candidate) => selected.has(candidate.path) && candidate.role !== 'lora')
      .map((candidate) => ({
        path: candidate.path,
        role: candidate.role as 'dit' | 'text_encoder' | 'vae' | 'support' | 'full',
        name: candidate.name,
        relativePath: candidate.relativePath,
        ...(candidate.layout === 'unknown' ? {} : { layout: candidate.layout }),
      }))
    if (!items.length) {
      toast.push('先勾选要登记的模型', 'info')
      return
    }
    setBusy('scan')
    try {
      const result = await call<{ added: number; updated: number; missing: string[] }>(
        Ipc.modelsRegisterScan,
        { items },
      )
      toast.push(
        `已登记 ${result.added + result.updated} 个模型` +
          (result.missing.length ? `，${result.missing.length} 个文件已不存在` : ''),
        result.missing.length ? 'info' : 'success',
      )
      setScan(null)
      setSelected(new Set())
    } catch (cause) {
      toast.push(cause instanceof Error ? cause.message : String(cause), 'error')
    } finally {
      setBusy(null)
    }
  }, [scan, selected, toast])

  const root = settings?.modelsRoot?.trim() || ''
  const chosenRoleCount = roles.filter((role) => settings?.modelDirectories?.[role.key]).length

  return (
    <>
      <Card className="mx-5 mt-4 rounded-[8px] px-4 py-3.5" data-model-directories>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[5px] border border-[var(--color-border-subtle)] bg-white/[0.03]">
              <HardDrive className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-ui font-semibold">模型目录</h2>
                <Pill tone={chosenRoleCount ? 'accent' : 'neutral'}>
                  {chosenRoleCount ? `${chosenRoleCount} 个角色自定义` : '使用默认目录'}
                </Pill>
              </div>
              <p className="mt-1 truncate text-caption text-[var(--color-text-tertiary)]" title={root || '应用数据目录 / models'}>
                根目录：{root || '应用数据目录 / models'}
              </p>
              <p className="mt-0.5 text-caption text-[var(--color-text-tertiary)]">
                扫描只读取文件，不复制、不移动，也不会在你的目录里新建文件夹。
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button tone="secondary" disabled={busy !== null} onClick={() => void chooseRoot()}>
              <FolderOpen className="size-4" /> 更改根目录
            </Button>
            <Button tone="primary" disabled={busy !== null} onClick={() => void runScan()} data-scan-models>
              {busy === 'scan' ? <Spinner className="size-4" /> : <FolderSearch className="size-4" />}
              识别已有模型
            </Button>
            <Button tone="ghost" disabled={busy !== null} onClick={() => void cleanup()}>
              {busy === 'clean' ? <Spinner className="size-4" /> : <Sparkles className="size-4" />}
              清理空目录
            </Button>
          </div>
        </div>

        <button
          type="button"
          className="mt-2.5 text-caption text-[var(--color-text-tertiary)] underline-offset-2 hover:underline"
          onClick={() => setAdvanced((value) => !value)}
        >
          {advanced ? '收起角色目录' : '按角色分别指定目录…'}
        </button>
        {advanced ? (
          <div className="mt-2 space-y-1.5 border-t border-[var(--color-border-subtle)] pt-2">
            {roles.map((role) => {
              const path = settings?.modelDirectories?.[role.key] ?? ''
              return (
                <div key={role.key} className="flex items-center justify-between gap-3 text-caption">
                  <span className="w-24 shrink-0 text-[var(--color-text-secondary)]">{role.label}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--color-text-tertiary)]" title={path || role.hint}>
                    {path || role.hint}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <Button tone="ghost" className="!h-6 !px-2" onClick={() => void chooseRole(role.key)}>
                      更改
                    </Button>
                    {path ? (
                      <Button tone="ghost" className="!h-6 !px-2" onClick={() => void clearRole(role.key)}>
                        清除
                      </Button>
                    ) : null}
                  </span>
                </div>
              )
            })}
          </div>
        ) : null}
        {error ? <p className="mt-2 text-caption text-red-400">{error}</p> : null}
      </Card>

      <Modal
        open={scan !== null}
        title="识别到的模型"
        onClose={() => setScan(null)}
        width="max-w-3xl"
        footer={
          <>
            <span className="mr-auto text-caption text-[var(--color-text-tertiary)]">
              已选 {selected.size} / {scan?.candidates.length ?? 0}
            </span>
            <Button tone="ghost" onClick={() => setScan(null)}>
              取消
            </Button>
            <Button tone="primary" disabled={busy !== null || selected.size === 0} onClick={() => void register()}>
              登记到模型库
            </Button>
          </>
        }
      >
        {scan ? (
          <div className="space-y-2">
            <p className="truncate text-caption text-[var(--color-text-tertiary)]" title={scan.root}>
              {scan.root} · 扫描到 {scan.candidates.length} 项
            </p>
            <div className="max-h-[52vh] space-y-1 overflow-y-auto pr-1">
              {scan.candidates.map((candidate) => {
                const checked = selected.has(candidate.path)
                const disabled = candidate.role === 'lora'
                return (
                  <label
                    key={candidate.path}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-[5px] border px-2 py-1.5 text-caption',
                      checked
                        ? 'border-accent-500/40 bg-accent-500/[0.06]'
                        : 'border-[var(--color-border-subtle)]',
                      disabled && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 shrink-0"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggle(candidate.path)}
                    />
                    <Pill tone={roleTone[candidate.role]}>{roleLabel[candidate.role]}</Pill>
                    <span className="min-w-0 flex-1 truncate" title={candidate.path}>
                      {candidate.relativePath}
                    </span>
                    <span className="shrink-0 tabular-nums text-[var(--color-text-tertiary)]">
                      {candidate.layout === 'diffusers-folder' ? '目录' : bytes(candidate.size)}
                    </span>
                  </label>
                )
              })}
              {!scan.candidates.length ? (
                <p className="py-6 text-center text-ui text-[var(--color-text-tertiary)]">
                  没有找到可识别的模型文件；确认目录里是 safetensors/gguf 权重。
                </p>
              ) : null}
            </div>
            <p className="text-caption text-[var(--color-text-tertiary)]">
              LoRA 请用「导入 LoRA」加入适配器；登记不会改动原文件，删掉记录也不会删除文件。
            </p>
          </div>
        ) : null}
      </Modal>
    </>
  )
}
