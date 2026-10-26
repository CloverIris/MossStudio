import { Copy, ExternalLink, Globe2, QrCode, RefreshCw } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useMemo, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { WebAccessInfo } from '@shared/backend'
import type { Settings } from '@shared/types'
import { call } from '../lib/api'
import { useApp } from '../store'
import { Button, Field, Input, Select, Sheet, Spinner, Switch, useToast } from './ui'

interface Props {
  open: boolean
  onClose: () => void
  initialInstanceId?: string
}

export function WebUiSettingsSheet({ open, onClose, initialInstanceId }: Props): React.JSX.Element {
  const toast = useToast()
  const settings = useApp((state) => state.settings)
  const instances = useApp((state) => state.instances)
  const saveSettings = useApp((state) => state.saveSettings)
  const [enabled, setEnabled] = useState(false)
  const [instanceId, setInstanceId] = useState('')
  const [port, setPort] = useState('')
  const [access, setAccess] = useState<WebAccessInfo | null>(null)
  const [qr, setQr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || !settings) return
    setEnabled(settings.lanWebEnabled)
    setInstanceId(settings.lanWebInstanceId ?? initialInstanceId ?? '')
    setPort(settings.lanWebPort ? String(settings.lanWebPort) : '')
    void refresh()
  }, [open, settings, initialInstanceId])

  const primary = useMemo(() => {
    if (!access?.urls.length) return ''
    return access.urls.find((url) => !url.includes('127.0.0.1')) ?? ''
  }, [access])

  useEffect(() => {
    if (!open || !primary) {
      setQr('')
      return
    }
    let cancelled = false
    void QRCode.toDataURL(primary, { margin: 1, width: 224, color: { dark: '#10141c', light: '#ffffff' } })
      .then((url) => {
        if (!cancelled) setQr(url)
      })
      .catch(() => setQr(''))
    return () => {
      cancelled = true
    }
  }, [open, primary])

  async function refresh(): Promise<void> {
    try {
      setAccess(await call<WebAccessInfo>(Ipc.webAccessInfo))
    } catch {
      setAccess(null)
    }
  }

  async function save(): Promise<void> {
    const parsedPort = port.trim() ? Number(port.trim()) : null
    if (parsedPort !== null && (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535)) {
      toast.push('端口需在 1024–65535 之间，留空则自动分配', 'error')
      return
    }
    setBusy(true)
    try {
      const patch: Partial<Settings> = {
        lanWebEnabled: enabled,
        lanWebPort: parsedPort,
        lanWebInstanceId: instanceId || null,
      }
      await saveSettings(patch)
      await refresh()
      toast.push(enabled ? '局域网 WebUI 已开启' : '局域网 WebUI 已关闭', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function rotate(): Promise<void> {
    setBusy(true)
    try {
      const next = await call<WebAccessInfo>(Ipc.webAccessRestart)
      setAccess(next)
      toast.push('访问密钥已重新生成', 'success')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function copy(value: string): Promise<void> {
    await navigator.clipboard.writeText(value)
    toast.push('已复制', 'success')
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="外部 UI · 局域网 WebUI"
      description="把 MossStudio 暴露给同一 Wi‑Fi 的手机/浏览器；由桌面主机持有模型与任务。"
      width="max-w-[560px]"
      footer={
        <>
          <Button tone="ghost" onClick={onClose} disabled={busy}>关闭</Button>
          <Button tone="primary" onClick={() => void save()} disabled={busy}>
            {busy ? <Spinner className="size-4" /> : '保存并应用'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--color-border-subtle)] bg-white/[0.025] px-3 py-2.5">
          <div>
            <div className="text-ui font-medium">启用外部 UI</div>
            <div className="mt-0.5 text-caption text-[var(--color-text-tertiary)]">
              仅在可信局域网使用；关闭后只监听 127.0.0.1
            </div>
          </div>
          <Switch aria-label="启用外部 UI" checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="绑定实例">
            <Select value={instanceId} onChange={(event) => setInstanceId(event.target.value)}>
              <option value="">不绑定（页面内选择）</option>
              {instances.map((instance) => (
                <option key={instance.id} value={instance.id}>{instance.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="端口">
            <Input
              value={port}
              onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, ''))}
              placeholder="留空自动"
              inputMode="numeric"
            />
          </Field>
        </div>

        <div className="rounded-lg border border-[var(--color-border-subtle)] p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-ui font-medium">
              <Globe2 className="size-4 text-accent-300" /> 访问入口
            </div>
            <Button tone="ghost" onClick={() => void refresh()}>
              <RefreshCw className="size-4" />
            </Button>
          </div>
          {!access?.ready ? (
            <p className="mt-2 text-ui leading-5 text-amber-300">
              {access?.error ?? '保存后生成访问入口'}
            </p>
          ) : (
            <div className="mt-2 space-y-1.5">
              <div className="mb-2 flex items-center gap-2">
                <Button
                  tone="ghost"
                  onClick={() => {
                    const local = access.urls.find((url) => url.includes('127.0.0.1'))
                    if (local) void call(Ipc.openExternal, { url: local })
                  }}
                >
                  <span className="inline-flex items-center gap-1"><Globe2 className="size-4" /> 本机打开</span>
                </Button>
                <span className="text-caption text-[var(--color-text-tertiary)]">先用本机验证，再用手机扫二维码</span>
              </div>
              {access.urls.map((url) => (
                <div key={url} className="flex items-center gap-2">
                  <span className="w-7 shrink-0 text-micro text-[var(--color-text-tertiary)]">
                    {url.includes('127.0.0.1') ? '本机' : '局域网'}
                  </span>
                  <code className="min-w-0 flex-1 truncate text-caption text-[var(--color-text-secondary)]">{url}</code>
                  <button type="button" className="shrink-0 text-accent-300" onClick={() => void copy(url)}>
                    <Copy className="size-4" />
                  </button>
                  <button
                    type="button"
                    className="shrink-0 text-accent-300"
                    onClick={() => void call(Ipc.openExternal, { url })}
                  >
                    <ExternalLink className="size-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="mt-1 inline-flex items-center gap-1 text-caption text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
                onClick={() => void rotate()}
              >
                <QrCode className="size-4" /> 重新生成密钥（会断开现有页面）
              </button>
            </div>
          )}
        </div>

        {qr ? (
          <div className="flex items-center gap-4 rounded-lg border border-[var(--color-border-subtle)] p-3">
            <img src={qr} alt="MossStudio WebUI 二维码" className="size-28 rounded bg-white p-1" />
            <div className="min-w-0">
              <div className="text-ui font-medium">手机扫码打开</div>
              <p className="mt-1 text-caption leading-4 text-[var(--color-text-tertiary)]">
                二维码包含访问 token；不要截图发到公共群。绑定实例后页面会默认选中它。
              </p>
              <button
                type="button"
                className="mt-2 text-caption text-accent-300"
                onClick={() => void copy(primary)}
              >
                复制当前地址
              </button>
            </div>
          </div>
        ) : null}

        <p className="text-caption leading-4 text-[var(--color-text-tertiary)]">
          当前手机端覆盖提示词、实例、尺寸/步数/seed、生成与任务状态；画布/画廊/完整 Project 仍在桌面版。
          对外暴露前请确认同一网络可信。
        </p>
      </div>
    </Sheet>
  )
}
