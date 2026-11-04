import { FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { SshAuthMethod } from '@shared/types'
import { call } from '../../lib/api'
import { Advanced, Button, Field, IconButton, Input, Modal, Segmented, Spinner, Switch, useToast } from '../../components/ui'
import { errorText } from './fields'
import { validateHostForm, type HostForm, type HostFormErrors } from './hostForm'

function FieldError({ message }: { message?: string }): React.JSX.Element | null {
  return message ? <span role="alert" className="text-caption text-danger">{message}</span> : null
}

/** 添加 / 编辑 SSH 主机. Saving tests the connection right away (done by the caller). */
export function HostDialog({ open, initial, onClose, onSave }: {
  open: boolean
  initial: HostForm
  onClose: () => void
  onSave: (form: HostForm) => Promise<boolean>
}): React.JSX.Element {
  const toast = useToast()
  const [form, setForm] = useState(initial)
  const [errors, setErrors] = useState<HostFormErrors>({})
  const [saving, setSaving] = useState(false)

  // Start from `initial` each time the dialog opens; typing must not be reset by parent renders.
  const [openedWith, setOpenedWith] = useState<HostForm | null>(null)
  useEffect(() => {
    if (open && openedWith === null) { setOpenedWith(initial); setForm(initial); setErrors({}) }
    if (!open && openedWith !== null) setOpenedWith(null)
  }, [open, initial, openedWith])

  function set<K extends keyof HostForm>(key: K, value: HostForm[K]): void {
    setForm((current) => ({ ...current, [key]: value }))
    if (errors[key]) setErrors((current) => ({ ...current, [key]: undefined }))
  }

  async function submit(): Promise<void> {
    const next = validateHostForm(form)
    setErrors(next)
    if (Object.values(next).some(Boolean)) return
    setSaving(true)
    const ok = await onSave(form)
    setSaving(false)
    if (ok) onClose()
  }

  async function pickKey(): Promise<void> {
    try {
      const path = await call<string | null>(Ipc.pickDialog, { kind: 'file', title: '选择 SSH 私钥文件' })
      if (path) set('identityFile', path)
    } catch (error) {
      toast.push(errorText(error), 'error')
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={form.id ? '编辑 SSH 主机' : '添加 SSH 主机'}
      description="需要一台装有 NVIDIA 显卡的 Linux 电脑。保存后会马上测试连接；第一次连接会记住主机的指纹。"
      width="max-w-xl"
      footer={(
        <>
          <Button tone="ghost" size="md" onClick={onClose}>取消</Button>
          <Button tone="primary" size="md" onClick={() => void submit()} disabled={saving}>
            {saving ? <Spinner /> : null}保存并测试
          </Button>
        </>
      )}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => { event.preventDefault(); void submit() }}
      >
        <div className="grid grid-cols-[1fr_96px] gap-3">
          <Field label="地址">
            <Input data-dialog-initial-focus value={form.host} placeholder="192.168.1.20 或 gpu.example.com" aria-invalid={Boolean(errors.host) || undefined} onChange={(event) => set('host', event.target.value)} />
            <FieldError message={errors.host} />
          </Field>
          <Field label="端口">
            <Input inputMode="numeric" value={form.port} aria-invalid={Boolean(errors.port) || undefined} onChange={(event) => set('port', event.target.value.replace(/[^0-9]/g, ''))} />
            <FieldError message={errors.port} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="用户名">
            <Input value={form.user} placeholder="ubuntu" aria-invalid={Boolean(errors.user) || undefined} onChange={(event) => set('user', event.target.value)} />
            <FieldError message={errors.user} />
          </Field>
          <Field label="显示名称" hint="留空时使用地址">
            <Input value={form.name} placeholder="例如：4090 工作站" onChange={(event) => set('name', event.target.value)} />
          </Field>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-caption font-medium text-ink-2">登录方式</span>
          <Segmented<SshAuthMethod>
            label="登录方式"
            block
            value={form.authMethod}
            onChange={(value) => set('authMethod', value)}
            options={[
              { value: 'identityFile', label: '密钥' },
              { value: 'password', label: '密码' },
              { value: 'none', label: '无需验证' },
            ]}
          />
          {form.authMethod === 'identityFile' ? (
            <Field label="私钥文件" hint="留空时使用系统默认的密钥或 SSH agent。有密码的私钥请先加入 agent。">
              <div className="flex gap-2">
                <Input className="min-w-0 flex-1 font-mono text-caption" value={form.identityFile} placeholder="~/.ssh/id_ed25519" onChange={(event) => set('identityFile', event.target.value)} />
                <IconButton label="选择私钥文件" onClick={() => void pickKey()}><FolderOpen className="size-4" /></IconButton>
              </div>
            </Field>
          ) : form.authMethod === 'password' ? (
            <Field label="密码" hint="加密保存在本机。">
              <Input
                type="password"
                autoComplete="new-password"
                value={form.password}
                placeholder={form.hasPassword ? '已保存，留空不修改' : '输入 SSH 密码'}
                aria-invalid={Boolean(errors.password) || undefined}
                onChange={(event) => set('password', event.target.value)}
              />
              <FieldError message={errors.password} />
            </Field>
          ) : (
            <p className="text-caption text-ink-2">只适用于服务器允许免验证登录的账户。</p>
          )}
        </div>
        <div className="-mx-3.5 rounded-lg bg-panel">
          <Advanced summary="远程目录、下载代理、HF 地址和令牌">
            <div className="flex flex-col gap-3 px-3.5 pb-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="引擎目录"><Input className="font-mono text-caption" value={form.engineRoot} onChange={(event) => set('engineRoot', event.target.value)} /></Field>
                <Field label="模型目录"><Input className="font-mono text-caption" value={form.modelsRoot} onChange={(event) => set('modelsRoot', event.target.value)} /></Field>
                <Field label="输出目录"><Input className="font-mono text-caption" value={form.outputRoot} onChange={(event) => set('outputRoot', event.target.value)} /></Field>
                <Field label="训练器目录">
                  <Input className="font-mono text-caption" value={form.trainerRoot} aria-invalid={Boolean(errors.trainerRoot) || undefined} onChange={(event) => set('trainerRoot', event.target.value)} />
                  <FieldError message={errors.trainerRoot} />
                </Field>
              </div>
              <Field label="下载代理" hint="从远程主机访问的代理地址。留空时使用远程主机自己的网络设置。">
                <Input className="font-mono text-caption" value={form.downloadProxy} placeholder="socks5h://127.0.0.1:7890" aria-invalid={Boolean(errors.downloadProxy) || undefined} onChange={(event) => set('downloadProxy', event.target.value)} />
                <FieldError message={errors.downloadProxy} />
              </Field>
              <div className="grid grid-cols-[1fr_120px] gap-3">
                <Field label="Hugging Face 地址" hint="留空时使用 网络 设置里的地址。">
                  <Input className="font-mono text-caption" value={form.hfEndpoint} placeholder="https://hf-mirror.com" aria-invalid={Boolean(errors.hfEndpoint) || undefined} onChange={(event) => set('hfEndpoint', event.target.value)} />
                  <FieldError message={errors.hfEndpoint} />
                </Field>
                <Field label="同时下载数">
                  <Input inputMode="numeric" value={form.downloadConcurrency} placeholder="默认" aria-invalid={Boolean(errors.downloadConcurrency) || undefined} onChange={(event) => set('downloadConcurrency', event.target.value.replace(/[^0-9]/g, ''))} />
                  <FieldError message={errors.downloadConcurrency} />
                </Field>
              </div>
              <Field label="Hugging Face 令牌" hint="只给这台主机用。留空时使用 网络 设置里的令牌。">
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={form.hfToken}
                  disabled={form.clearHfToken}
                  placeholder={form.hasHfToken ? '已保存，留空不修改' : 'hf_…'}
                  onChange={(event) => set('hfToken', event.target.value)}
                />
              </Field>
              {form.hasHfToken ? (
                <label className="flex items-center justify-between gap-3 text-ui text-ink">
                  清除这台主机的令牌
                  <Switch aria-label="清除这台主机的令牌" checked={form.clearHfToken} onCheckedChange={(value) => { set('clearHfToken', value); if (value) set('hfToken', '') }} />
                </label>
              ) : null}
            </div>
          </Advanced>
        </div>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  )
}
