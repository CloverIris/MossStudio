import { Bot, Copy, Plus, Send, Settings2, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { AiConversationInfo, AiMessage, AiProviderInfo, AiProviderKind } from '@shared/ai'
import { AI_PROVIDER_PRESETS } from '@shared/ai'
import { call } from '../lib/api'
import { useApp } from '../store'
import { Button, Input, Modal, Select, Spinner, useToast } from './ui'

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

function splitPrompt(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.includes('{') || trimmed.includes('[')) return [trimmed]
  return trimmed.split(/\n+|\s*[,，]\s*/).map((item) => item.trim()).filter(Boolean)
}

export function AgentSidebar({ embedded = false }: { embedded?: boolean } = {}): React.JSX.Element {
  const toast = useToast()
  const studioPrompt = useApp((state) => state.studioPrompt)
  const setStudioPrompt = useApp((state) => state.setStudioPrompt)
  const [providers, setProviders] = useState<AiProviderInfo[]>([])
  const [providerId, setProviderId] = useState('')
  const [conversations, setConversations] = useState<AiConversationInfo[]>([])
  const [conversation, setConversation] = useState<AiConversationInfo | null>(null)
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)
  const [accepted, setAccepted] = useState<Set<number>>(new Set())
  const endRef = useRef<HTMLDivElement>(null)

  async function refresh(): Promise<void> {
    try {
      const [nextProviders, nextConversations] = await Promise.all([
        call<AiProviderInfo[]>(Ipc.aiProvidersList),
        call<AiConversationInfo[]>(Ipc.aiConversations),
      ])
      setProviders(nextProviders)
      setProviderId((current) => current || nextProviders[0]?.id || '')
      setConversations(nextConversations)
    } catch {
      // keep
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, busy])

  useEffect(() => {
    if (!pendingPrompt) return
    setAccepted(new Set(splitPrompt(pendingPrompt).map((_, index) => index)))
  }, [pendingPrompt])

  async function sendText(raw: string): Promise<void> {
    if (!providerId) {
      setSettingsOpen(true)
      toast.push('先添加一个 AI Provider', 'info')
      return
    }
    const text = raw.trim()
    if (!text || busy) return
    const user: AiMessage = { id: `local-${Date.now()}`, role: 'user', content: text, createdAt: new Date().toISOString() }
    const history = [...messages, user]
    setMessages(history)
    setInput('')
    setBusy(true)
    try {
      const context = studioPrompt.trim()
        ? `\n\nCurrent MossStudio prompt:\n${studioPrompt.trim()}\nUse it as context when suggesting changes.`
        : ''
      const result = await call<{ reply: string; conversation: AiConversationInfo }>(Ipc.aiChat, {
        providerId,
        conversationId: conversation?.id,
        messages: history.map(({ role, content }) => ({ role, content })),
        system: `You are the MossStudio agent for MOSS-Image. Reply in the user's language; prompt suggestions stay in English.${context}`,
      })
      setConversation(result.conversation)
      setMessages(result.conversation.messages)
      await refresh()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
      setMessages(messages)
      setInput(text)
    } finally {
      setBusy(false)
    }
  }

  function send(): void {
    void sendText(input)
  }

  function newChat(): void {
    setConversation(null)
    setMessages([])
    setInput('')
  }

  async function openConversation(id: string): Promise<void> {
    const next = conversations.find((item) => item.id === id)
    if (!next) return
    setConversation(next)
    setMessages(next.messages)
    if (next.providerId) setProviderId(next.providerId)
  }

  function editProvider(provider?: AiProviderInfo): void {
    if (!provider) {
      setDraft(EMPTY)
    } else {
      setDraft({ id: provider.id, name: provider.name, kind: provider.kind, baseUrl: provider.baseUrl, model: provider.model, apiKey: '' })
    }
    setSettingsOpen(true)
  }

  async function saveProvider(): Promise<void> {
    if (!draft.name.trim() || !draft.baseUrl.trim() || !draft.model.trim()) {
      toast.push('名称、Base URL、模型都不能为空', 'error')
      return
    }
    try {
      await call<AiProviderInfo>(Ipc.aiProviderSave, {
        ...draft,
        apiKey: draft.apiKey || undefined,
        temperature: 0.7,
      })
      toast.push('Provider 已保存', 'success')
      setSettingsOpen(false)
      await refresh()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function removeProvider(id: string): Promise<void> {
    await call(Ipc.aiProviderRemove, { id })
    await refresh()
  }

  async function removeConversation(id: string): Promise<void> {
    await call(Ipc.aiConversationRemove, { id })
    if (conversation?.id === id) newChat()
    await refresh()
  }

  function applyPrompt(content: string): void {
    setPendingPrompt(content.trim())
  }

  const presetKind = AI_PROVIDER_PRESETS.filter((item) => item.kind === draft.kind)

  return (
    <aside className="glass-thin flex h-full w-full shrink-0 flex-col border-l border-[var(--color-border-subtle)]">
      {!embedded ? <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--color-border-subtle)] px-3">
        <div className="flex items-center gap-1.5 text-ui font-semibold"><Bot className="size-4 text-accent-300" /> Agent</div>
        <div className="flex items-center gap-1">
          <button type="button" className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-white/[0.05]" title="新对话" onClick={newChat}><Plus className="size-4" /></button>
          <button type="button" className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-white/[0.05]" title="Provider 设置" onClick={() => editProvider()}><Settings2 className="size-4" /></button>
        </div>
      </header> : null}

      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-2.5 py-2">
        <Select value={providerId} onChange={(event) => setProviderId(event.target.value)} className="min-w-0 flex-1 text-caption">
          {providers.length === 0 ? <option value="">未配置模型</option> : null}
          {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}
        </Select>
        <button type="button" className="rounded border border-[var(--color-border-subtle)] px-1.5 py-1 text-caption text-[var(--color-text-tertiary)]" onClick={() => setSettingsOpen(true)}>管理</button>
      </div>

      {providers.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-6 text-center">
          <Bot className="size-8 text-accent-300/60" />
          <p className="text-ui leading-5 text-[var(--color-text-secondary)]">
            连接 OpenAI、DeepSeek、Anthropic、Gemini 或本地 Ollama，让 Agent 帮你写 Prompt、拆分段、润色和翻译。
          </p>
          <Button tone="primary" onClick={() => setSettingsOpen(true)}>添加 AI Provider</Button>
          <p className="text-caption leading-4 text-[var(--color-text-tertiary)]">密钥只保存在本机应用数据目录。</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {messages.length === 0 ? (
            <div className="rounded-lg border border-[var(--color-border-subtle)] bg-white/[0.025] p-3 text-ui leading-5 text-[var(--color-text-secondary)]">
              可以直接说：<br />“把这段中文想法写成 MOSS-Image 英文 Prompt”<br />“拆成主体/光影/构图三段”<br />“把当前 Prompt 改得更像电影剧照”
            </div>
          ) : null}
          {messages.map((message) => (
            <div key={message.id} className={`mb-2.5 flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[92%] rounded-lg px-2.5 py-2 text-ui leading-[17px] ${message.role === 'user' ? 'bg-accent-500/15 text-[var(--color-text)]' : 'bg-white/[0.04] text-[var(--color-text-secondary)]'}`}>
                <div className="whitespace-pre-wrap break-words">{message.content}</div>
                {message.role === 'assistant' ? (
                  <div className="mt-1.5 flex items-center gap-2 border-t border-white/[0.06] pt-1.5 text-caption">
                    <button type="button" className="text-accent-300" onClick={() => applyPrompt(message.content)}>写入 Prompt</button>
                    <button type="button" className="inline-flex items-center gap-1 text-[var(--color-text-tertiary)]" onClick={() => void navigator.clipboard.writeText(message.content)}><Copy className="size-2.5" /> 复制</button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          {busy ? <div className="flex items-center gap-2 px-2 py-2 text-caption text-[var(--color-text-tertiary)]"><Spinner className="size-4" /> Agent 正在整理…</div> : null}
          <div ref={endRef} />
        </div>
      )}

      <div className="shrink-0 border-t border-[var(--color-border-subtle)] p-2.5">
        <div className="mb-1.5 flex flex-wrap gap-1">
          <button type="button" onClick={() => void sendText('请润色当前 Prompt，使画面更具体、更有电影感；直接给出最终英文 Prompt。')} className="rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-micro text-[var(--color-text-secondary)]">润色</button>
          <button type="button" onClick={() => void sendText('请把当前 Prompt 翻成中文，保留画面术语；只给译文。')} className="rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-micro text-[var(--color-text-secondary)]">译中</button>
          <button type="button" onClick={() => void sendText('请把当前想法拆成主体、光影、构图、风格四段英文 Prompt。')} className="rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-micro text-[var(--color-text-secondary)]">拆段</button>
        </div>
        <div className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            rows={2}
            placeholder="问 Agent，Enter 发送 / Shift+Enter 换行"
            className="app-input min-h-[48px] flex-1 resize-none text-ui"
          />
          <Button tone="primary" onClick={() => void send()} disabled={busy || !input.trim()} className="h-[48px] px-2.5">
            <Send className="size-4" />
          </Button>
        </div>
        {studioPrompt ? <div className="mt-1 truncate text-micro text-[var(--color-text-tertiary)]">已带上当前 Prompt 作为上下文</div> : null}
      </div>

      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="AI Provider" description="密钥只保存在本机；支持 OpenAI-compatible、Anthropic、Gemini、Ollama。" width="max-w-2xl">
        <div className="grid grid-cols-2 gap-3 p-4">
          <div className="col-span-2 flex flex-wrap gap-1.5">
            {AI_PROVIDER_PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                className="rounded-full border border-[var(--color-border-subtle)] px-2 py-1 text-caption text-[var(--color-text-secondary)] hover:border-accent-500/40"
                onClick={() => setDraft({ ...draft, name: preset.name, kind: preset.kind, baseUrl: preset.baseUrl, model: preset.model })}
              >
                {preset.name}
              </button>
            ))}
          </div>
          <label className="space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">名称</span><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label className="space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">协议</span><Select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as AiProviderKind })}>{(Object.keys(KIND_LABELS) as AiProviderKind[]).map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}</Select></label>
          <label className="col-span-2 space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">Base URL</span><Input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" /></label>
          <label className="space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">模型</span><Input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></label>
          <label className="space-y-1"><span className="text-caption text-[var(--color-text-tertiary)]">API Key</span><Input type="password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={draft.id ? '留空保留原密钥' : 'sk-...'} /></label>
          <div className="col-span-2 flex items-center justify-between border-t border-[var(--color-border-subtle)] pt-3">
            <div className="flex flex-wrap gap-2">
              {providers.map((provider) => (
                <span key={provider.id} className="inline-flex items-center gap-1 rounded border border-[var(--color-border-subtle)] px-2 py-1 text-caption">
                  {provider.name}
                  <button type="button" className="text-[var(--color-text-tertiary)]" onClick={() => editProvider(provider)}>编辑</button>
                  <button type="button" className="text-red-300" onClick={() => void removeProvider(provider.id)}><Trash2 className="size-2.5" /></button>
                </span>
              ))}
            </div>
            <Button tone="primary" onClick={() => void saveProvider()}>保存 Provider</Button>
          </div>
          {presetKind.length > 0 ? <p className="col-span-2 text-caption text-[var(--color-text-tertiary)]">选择预设只会填充地址和模型，仍需填 API Key。</p> : null}
        </div>
      </Modal>

      {conversations.length > 0 ? (
        <div className="max-h-24 shrink-0 overflow-y-auto border-t border-[var(--color-border-subtle)] px-2 py-1.5">
          <div className="mb-1 text-micro uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">历史</div>
          {conversations.slice(0, 5).map((item) => (
            <div key={item.id} className="flex items-center gap-1 py-0.5">
              <button type="button" className="min-w-0 flex-1 truncate text-left text-caption text-[var(--color-text-secondary)]" onClick={() => void openConversation(item.id)}>{item.title}</button>
              <button type="button" className="text-[var(--color-text-tertiary)]" onClick={() => void removeConversation(item.id)}><X className="size-2.5" /></button>
            </div>
          ))}
        </div>
      ) : null}

      <Modal
        open={Boolean(pendingPrompt)}
        onClose={() => setPendingPrompt(null)}
        title="确认 Prompt 改动"
        description="Agent 的建议不会直接覆盖当前 Prompt；红底为当前内容，绿底为建议内容。"
        width="max-w-3xl"
        footer={
          <>
            <Button tone="ghost" onClick={() => setPendingPrompt(null)}>驳回</Button>
            <Button
              tone="primary"
              onClick={() => {
                if (!pendingPrompt) return
                const picked = splitPrompt(pendingPrompt)
                  .filter((_, index) => accepted.has(index))
                  .join(', ')
                if (!picked) {
                  toast.push('至少勾选一段再采纳', 'info')
                  return
                }
                setStudioPrompt(picked)
                setPendingPrompt(null)
                toast.push('已写入勾选的分段', 'success')
              }}
            >
              采纳
            </Button>
          </>
        }
      >
        <div className="space-y-3 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <div className="mb-1 text-caption text-[var(--color-text-tertiary)]">当前 Prompt（红）</div>
              <div className="space-y-1">
                {splitPrompt(studioPrompt).map((segment, index) => (
                  <div key={`old-${index}`} className="rounded border border-red-500/20 bg-red-500/[0.06] px-2 py-1.5 text-caption leading-4 text-red-200">{segment}</div>
                ))}
                {!studioPrompt.trim() ? <div className="text-caption text-[var(--color-text-tertiary)]">（空）</div> : null}
              </div>
            </div>
            <div>
              <div className="mb-1 text-caption text-[var(--color-text-tertiary)]">Agent 建议（绿，逐段采纳）</div>
              <div className="space-y-1">
                {splitPrompt(pendingPrompt ?? '').map((segment, index) => (
                  <label key={`new-${index}`} className="flex cursor-pointer items-start gap-2 rounded border border-emerald-500/20 bg-emerald-500/[0.06] px-2 py-1.5 text-caption leading-4 text-emerald-200">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={accepted.has(index)}
                      onChange={(event) => {
                        const next = new Set(accepted)
                        if (event.target.checked) next.add(index)
                        else next.delete(index)
                        setAccepted(next)
                      }}
                    />
                    <span>{segment}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <p className="text-caption leading-4 text-[var(--color-text-tertiary)]">
            只会写入勾选的绿色段；未勾选的建议不会覆盖当前 Prompt。
          </p>
        </div>
      </Modal>
    </aside>
  )
}
