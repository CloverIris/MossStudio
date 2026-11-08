import { FolderSearch, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type { ModelDirectories, ModelDirectoryId, ModelScanResult, ScannedModel, Settings } from '@shared/types'
import { call, onEvent } from '../lib/api'
import { sizeText } from '../pages/models/logic'
import { Notice } from './common/Notice'
import { Button, EmptyState, Group, Modal, Pill, Row, Spinner, cn, useToast } from './ui'

const roles: Array<{ key: ModelDirectoryId; label: string }> = [
  { key: 'dit', label: '主模型' },
  { key: 'textEncoder', label: '文本编码器' },
  { key: 'vae', label: 'VAE' },
  { key: 'adapters', label: 'LoRA' },
  { key: 'support', label: '运行配置' },
]

const roleLabel: Record<ScannedModel['role'], string> = {
  dit: '主模型',
  text_encoder: '文本编码器',
  vae: 'VAE',
  support: '运行配置',
  full: '完整模型',
  lora: 'LoRA',
}

/**
 * Directory management for models, shown under 模型 › 高级: per-part folders
 * (picking one scans it for files to add) and cleanup. Using a folder of model
 * files as a model is 用电脑上的模型文件… on the 模型 tab. The model folder itself
 * is shown once, under 存储位置 on the same page, and changed in 设置 › 存储.
 * Selecting a folder only scans it; nothing is copied or created until the
 * user adds a file.
 */
export function ModelDirectoriesCard(): React.JSX.Element {
  const toast = useToast()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [scan, setScan] = useState<ModelScanResult | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'scan' | 'clean' | 'roots' | null>(null)
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
        toast.push(cause instanceof Error ? cause.message : String(cause), 'error')
      } finally {
        setBusy(null)
      }
    },
    [toast],
  )

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
        const path = await call<string | null>(Ipc.pickDialog, { kind: 'folder', title: '选择文件夹' })
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
      toast.push(result.removed.length ? `已清理 ${result.removed.length} 个空目录` : '没有需要清理的空目录', 'success')
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
      toast.push('先勾选要添加的模型', 'info')
      return
    }
    setBusy('scan')
    try {
      const result = await call<{ added: number; updated: number; missing: string[] }>(Ipc.modelsRegisterScan, { items })
      toast.push(
        `已添加 ${result.added + result.updated} 个模型` + (result.missing.length ? `，${result.missing.length} 个文件已不存在` : ''),
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

  return (
    <>
      {error ? (
        <Notice
          tone="danger"
          className="mb-2"
          action={
            <Button
              size="xs"
              onClick={() => {
                setError(null)
                void load()
              }}
            >
              重试
            </Button>
          }
        >
          读不到模型文件夹的设置：{error}
        </Notice>
      ) : null}
      <Group data-model-directories>
        {roles.map((role) => {
          const path = settings?.modelDirectories?.[role.key] ?? ''
          return (
            <Row key={role.key} title={`${role.label}文件夹`} description={path || '跟随模型文件夹'}>
              {path ? (
                <Button tone="ghost" disabled={busy !== null} onClick={() => void clearRole(role.key)}>
                  恢复默认
                </Button>
              ) : null}
              <Button tone="secondary" disabled={busy !== null} onClick={() => void chooseRole(role.key)}>
                更改
              </Button>
            </Row>
          )
        })}
        <Row title="清理空文件夹" description="删除模型文件夹里下载中断后留下的空文件夹。">
          <Button tone="secondary" disabled={busy !== null} onClick={() => void cleanup()}>
            {busy === 'clean' ? <Spinner /> : <Sparkles className="size-4" strokeWidth={1.6} />}
            清理
          </Button>
        </Row>
      </Group>

      <Modal
        open={scan !== null}
        title="找到的模型文件"
        onClose={() => setScan(null)}
        width="max-w-3xl"
        footer={
          <>
            <span className="tabular mr-auto text-caption text-ink-2">
              已选 {selected.size} / {scan?.candidates.length ?? 0}
            </span>
            <Button tone="ghost" size="md" onClick={() => setScan(null)}>
              取消
            </Button>
            <Button tone="primary" size="md" disabled={busy !== null || selected.size === 0} onClick={() => void register()}>
              添加到模型库
            </Button>
          </>
        }
      >
        {scan ? (
          <div className="flex flex-col gap-2">
            <p className="flex min-w-0 gap-3 text-caption text-ink-2">
              <span className="min-w-0 truncate" title={scan.root}>
                {scan.root}
              </span>
              <span className="tabular shrink-0">找到 {scan.candidates.length} 项</span>
            </p>
            <div className="flex max-h-[52vh] flex-col gap-0.5 overflow-y-auto">
              {scan.candidates.map((candidate) => {
                const checked = selected.has(candidate.path)
                const disabled = candidate.role === 'lora'
                return (
                  <label
                    key={candidate.path}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-ui transition-colors hover:bg-well',
                      checked && 'bg-well',
                      disabled && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-accent"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggle(candidate.path)}
                    />
                    <Pill tone={candidate.role === 'lora' ? 'neutral' : 'accent'}>{roleLabel[candidate.role]}</Pill>
                    <span className="min-w-0 flex-1 truncate text-ink" title={candidate.path}>
                      {candidate.relativePath}
                    </span>
                    <span className="tabular shrink-0 text-caption text-ink-2">
                      {candidate.layout === 'diffusers-folder' ? '文件夹' : sizeText(candidate.size)}
                    </span>
                  </label>
                )
              })}
              {!scan.candidates.length ? (
                <EmptyState
                  size="section"
                  icon={<FolderSearch className="size-6" strokeWidth={1.6} />}
                  title="没有找到能识别的模型文件"
                  description="确认文件夹里是 .safetensors 或 .gguf 权重。"
                />
              ) : null}
            </div>
            <p className="text-caption text-ink-2">LoRA 请在「LoRA」里导入。添加不会改动原文件，之后从模型库移除也不会删除文件。</p>
          </div>
        ) : null}
      </Modal>
    </>
  )
}
