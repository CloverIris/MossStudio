import { useEffect, useState } from 'react'
import type { AiProviderInfo, AiProviderKind } from '@shared/ai'
import { AI_PROVIDER_PRESETS } from '@shared/ai'
import { Ipc } from '@shared/channels'
import { Button, Field, IconButton, Input, Modal, Select, useToast } from '../../../components/ui'
import { call } from '../../../lib/api'
import { Trash2 } from 'lucide-react'

const KIND_LABELS: Record<AiProviderKind, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  ollama: 'Ollama',
}

interface Draft {
  id?: string
  name: string
  kind: AiProviderKind
  baseUrl: string
  model: string
  apiKey: string
}

const EMPTY: Draft = { name: '', kind: 'openai', baseUrl: '', model: '', apiKey: '' }

/** Connect the assistant to a language model service. Keys stay on this computer. */
export function ProviderDialog({
  open,
  providers,
  busy,
  onClose,
  onChanged,
}: {
  open: boolean
  providers: AiProviderInfo[]
  busy: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const toast = useToast()
  const [draft, setDraft] = useState<Draft>(EMPTY)
  useEffect(() => {
    if (open) setDraft(EMPTY)
  }, [open])

  async function save(): Promise<void> {
    if (!draft.name.trim() || !draft.baseUrl.trim() || !draft.model.trim()) {
      toast.push('名称、地址和模型都要填写', 'error')
      return
    }
    try {
      await call<AiProviderInfo>(Ipc.aiProviderSave, { ...draft, apiKey: draft.apiKey || undefined, temperature: 0.7 })
      toast.push('已保存', 'success')
      setDraft(EMPTY)
      await onChanged()
      onClose()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await call(Ipc.aiProviderRemove, { id })
      await onChanged()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="连接语言模型"
      description="助手通过你选择的语言模型服务工作，需要支持工具调用（function calling）。密钥只保存在这台电脑上。"
      width="max-w-2xl"
      footer={
        <>
          <Button tone="ghost" size="md" onClick={onClose}>
            取消
          </Button>
          <Button tone="primary" size="md" onClick={() => void save()}>
            {draft.id ? '保存修改' : '添加'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {providers.length ? (
          <section className="flex flex-col gap-1">
            <div className="text-caption font-semibold text-ink-2">已连接</div>
            {providers.map((provider) => (
              <div key={provider.id} className="flex items-center gap-2 rounded-lg bg-panel py-1 pl-3 pr-1">
                <span className="min-w-0 flex-1 truncate text-ui text-ink">
                  {provider.name}
                  <span className="text-ink-2"> · {provider.model}</span>
                </span>
                <Button
                  tone="ghost"
                  size="sm"
                  onClick={() =>
                    setDraft({
                      id: provider.id,
                      name: provider.name,
                      kind: provider.kind,
                      baseUrl: provider.baseUrl,
                      model: provider.model,
                      apiKey: '',
                    })
                  }
                >
                  编辑
                </Button>
                <IconButton label={`删除 ${provider.name}`} disabled={busy} onClick={() => void remove(provider.id)}>
                  <Trash2 className="size-4" strokeWidth={1.6} />
                </IconButton>
              </div>
            ))}
          </section>
        ) : null}

        <section className="flex flex-col gap-3">
          <div className="text-caption font-semibold text-ink-2">{draft.id ? `编辑「${draft.name}」` : '添加新的'}</div>
          {!draft.id ? (
            <div className="flex flex-wrap gap-1.5">
              {AI_PROVIDER_PRESETS.map((preset) => (
                <Button
                  key={preset.name}
                  tone="secondary"
                  size="sm"
                  onClick={() => setDraft({ ...draft, name: preset.name, kind: preset.kind, baseUrl: preset.baseUrl, model: preset.model })}
                >
                  {preset.name}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="名称">
              <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </Field>
            <Field label="接口类型">
              <Select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as AiProviderKind })}>
                {(Object.keys(KIND_LABELS) as AiProviderKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABELS[kind]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="地址" className="col-span-2">
              <Input
                value={draft.baseUrl}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                placeholder="https://api.openai.com/v1"
              />
            </Field>
            <Field label="模型">
              <Input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
            </Field>
            <Field label="API Key">
              <Input
                type="password"
                value={draft.apiKey}
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                placeholder={draft.id ? '留空则保留原来的' : 'sk-...'}
              />
            </Field>
          </div>
        </section>
      </div>
    </Modal>
  )
}
