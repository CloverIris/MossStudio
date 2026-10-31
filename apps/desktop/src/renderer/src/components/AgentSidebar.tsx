import { AlertCircle, Bot, Check, Copy, History, Plus, Send, Settings2, Trash2, Wrench, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type { AiConversationInfo, AiMessage, AiProviderInfo, AiProviderKind, AiStreamEvent, AiToolCall } from '@shared/ai'
import { AI_PROVIDER_PRESETS } from '@shared/ai'
import { call, onEvent } from '../lib/api'
import { useApp } from '../store'
import { Button, Input, Modal, Select, Spinner, useCopyText, useToast } from './ui'
import { useUiAnimationEnabled } from './motion'

const KIND_LABELS: Record<AiProviderKind, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  ollama: 'Ollama',
}

const TOOL_LABELS: Record<string, string> = {
  studio_read_context: '读取画布',
  studio_set_prompt: '写入提示词',
  studio_set_sampler: '修改参数',
  studio_add_layer: '添加图层',
  studio_generate: '开始生成',
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

/** Survives unmounts (tab switches, Canvas selection) so the chat never loses its place. */
const CONVERSATION_KEY = 'mossstudio.agentConversationId'

function splitPrompt(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.includes('{') || trimmed.includes('[')) return [trimmed]
  return trimmed.split(/\n+|\s*[,，]\s*/).map((item) => item.trim()).filter(Boolean)
}

interface ToolTrace {
  id: string
  name: string
  status: 'running' | 'ok' | 'error'
  detail: string
}

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name
}

function toolDetail(content: string): string {
  if (!content) return ''
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (typeof parsed.error === 'string') return parsed.error
    const entries = Object.entries(parsed).slice(0, 3).map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    return entries.join(' · ')
  } catch {
    return content.slice(0, 120)
  }
}

export function AgentSidebar({ embedded = false }: { embedded?: boolean } = {}): React.JSX.Element {
  const toast = useToast()
  const copyText = useCopyText()
  const animate = useUiAnimationEnabled()
  const studioPrompt = useApp((state) => state.studioPrompt)
  const setStudioPrompt = useApp((state) => state.setStudioPrompt)
  const [providers, setProviders] = useState<AiProviderInfo[]>([])
  const [providerId, setProviderId] = useState('')
  const [conversations, setConversations] = useState<AiConversationInfo[]>([])
  const [conversation, setConversation] = useState<AiConversationInfo | null>(null)
  const [failedText, setFailedText] = useState<string | null>(null)
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const [streamText, setStreamText] = useState('')
  const [streamTools, setStreamTools] = useState<ToolTrace[]>([])
  const [streaming, setStreaming] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
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
      setProviderId((current) => nextProviders.some((provider) => provider.id === current) ? current : nextProviders[0]?.id || '')
      setConversations(nextConversations)
    } catch {
      // keep
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  // Restore the conversation the user was in before this panel last unmounted.
  useEffect(() => {
    const saved = localStorage.getItem(CONVERSATION_KEY)
    if (!saved || conversation || conversations.length === 0) return
    const next = conversations.find((item) => item.id === saved)
    if (!next) return
    setConversation(next)
    setMessages(next.messages)
    if (next.providerId) setProviderId(next.providerId)
  }, [conversations, conversation])

  useEffect(() => {
    if (conversation?.id) localStorage.setItem(CONVERSATION_KEY, conversation.id)
  }, [conversation?.id])

  // Streaming: the main process pushes deltas and tool traces for this turn.
  useEffect(() => onEvent<AiStreamEvent>(Events.aiStream, (event) => {
    if (event.type === 'start') {
      setStreaming(true)
      setStreamText('')
      setStreamTools([])
      return
    }
    if (event.type === 'delta') {
      setStreamText((current) => current + event.text)
      return
    }
    if (event.type === 'tool') {
      setStreamTools((current) => [...current, { id: event.call.id, name: event.call.name, status: 'running', detail: '' }])
      return
    }
    if (event.type === 'tool-result') {
      setStreamTools((current) => current.map((trace) => trace.id === event.callId
        ? { ...trace, status: event.result.ok ? 'ok' as const : 'error' as const, detail: toolDetail(event.result.content) }
        : trace))
      return
    }
    if (event.type === 'done') {
      setConversation(event.conversation)
      setMessages(event.conversation.messages)
      setStreaming(false)
      setStreamText('')
      setStreamTools([])
      void refresh()
      return
    }
    if (event.type === 'error') {
      setStreaming(false)
      toast.push(event.message, 'error')
    }
  }), [toast])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest', behavior: animate ? 'smooth' : 'instant' })
  }, [messages, busy, streamText, streamTools.length, animate])

  useEffect(() => {
    if (!pendingPrompt) return
    setAccepted(new Set(splitPrompt(pendingPrompt).map((_, index) => index)))
  }, [pendingPrompt])

  async function sendText(raw: string, fromComposer = false): Promise<void> {
    if (sending.current) return
    if (!providerId) {
      setSettingsOpen(true)
      toast.push('先添加一个 AI Provider', 'info')
      return
    }
    const text = raw.trim()
    if (!text) return
    sending.current = true
    const user: AiMessage = { id: `local-${Date.now()}`, role: 'user', content: text, createdAt: new Date().toISOString() }
    setMessages((current) => [...current, user])
    setFailedText(null)
    if (fromComposer) setInput('')
    setBusy(true)
    try {
      const context = studioPrompt.trim()
        ? `The Studio prompt box currently holds:\n${studioPrompt.trim()}`
        : ''
      const result = await call<{ reply: string; conversation: AiConversationInfo }>(Ipc.aiChat, {
        providerId,
        conversationId: conversation?.id,
        message: text,
        context: context || undefined,
      })
      setConversation(result.conversation)
      setMessages(result.conversation.messages)
      await refresh()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
      // Keep the message on screen so the user can retry it without retyping.
      setFailedText(text)
      if (fromComposer) setInput((current) => current || text)
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  /** Re-run the last turn in place (standard chatbot "regenerate"). */
  async function regenerate(): Promise<void> {
    if (sending.current || !providerId) return
    if (!conversation?.id) return
    sending.current = true
    setBusy(true)
    setFailedText(null)
    try {
      const result = await call<{ reply: string; conversation: AiConversationInfo }>(Ipc.aiChat, {
        providerId,
        conversationId: conversation.id,
        regenerate: true,
        context: studioPrompt.trim() ? `The Studio prompt box currently holds:\n${studioPrompt.trim()}` : undefined,
      })
      setConversation(result.conversation)
      setMessages(result.conversation.messages)
      await refresh()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  function send(): void {
    void sendText(input, true)
  }

  function newChat(): void {
    if (sending.current) return
    localStorage.removeItem(CONVERSATION_KEY)
    setConversation(null)
    setMessages([])
    setInput('')
    setFailedText(null)
    setStreaming(false)
    setStreamText('')
    setStreamTools([])
  }

  function retry(): void {
    const text = failedText
    if (!text) return
    setFailedText(null)
    void sendText(text)
  }

  async function openConversation(id: string): Promise<void> {
    if (sending.current) return
    const next = conversations.find((item) => item.id === id)
    if (!next) return
    setConversation(next)
    setMessages(next.messages)
    if (next.providerId) setProviderId(next.providerId)
    setHistoryOpen(false)
  }

  async function renameConversation(id: string, title: string): Promise<void> {
    setRenamingId(null)
    const trimmed = title.trim()
    if (!trimmed) return
    try {
      const next = await call<AiConversationInfo | null>(Ipc.aiConversationRename, { id, title: trimmed })
      if (next && conversation?.id === id) setConversation(next)
      await refresh()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
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
    if (sending.current) return
    try {
      await call(Ipc.aiProviderRemove, { id })
      await refresh()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function removeConversation(id: string): Promise<void> {
    if (sending.current) return
    try {
      await call(Ipc.aiConversationRemove, { id })
      if (conversation?.id === id) newChat()
      await refresh()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  function applyPrompt(content: string): void {
    setPendingPrompt(content.trim())
  }

  const presetKind = AI_PROVIDER_PRESETS.filter((item) => item.kind === draft.kind)
  const lastAssistantId = [...messages].reverse().find((message) => message.role === 'assistant')?.id
  const toolResults = useMemo(() => {
    const map = new Map<string, AiMessage>()
    for (const message of messages) if (message.role === 'tool' && message.toolCallId) map.set(message.toolCallId, message)
    return map
  }, [messages])

  function renderToolChips(calls: AiToolCall[]): React.JSX.Element {
    return (
      <div className="mt-1.5 space-y-1 border-t border-white/[0.06] pt-1.5">
        {calls.map((call_) => {
          const result = toolResults.get(call_.id)
          return (
            <div key={call_.id} className="flex items-start gap-1.5 text-caption">
              {result ? (
                result.error ? <AlertCircle className="mt-0.5 size-3 shrink-0 text-red-400" /> : <Check className="mt-0.5 size-3 shrink-0 text-emerald-400" />
              ) : <Wrench className="mt-0.5 size-3 shrink-0 text-accent-300" />}
              <span className="min-w-0">
                <span className="text-[var(--color-text-secondary)]">{toolLabel(call_.name)}</span>
                {result ? <span className="text-[var(--color-text-tertiary)]"> · {toolDetail(result.content)}</span> : null}
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <aside className={`flex h-full w-full shrink-0 flex-col ${embedded ? '' : 'glass-thin border-l border-[var(--color-border-subtle)]'}`}>
      {!embedded ? (
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--color-border-subtle)] px-3">
          <div className="flex items-center gap-1.5 text-ui font-semibold"><Bot className="size-4 text-accent-300" /> Agent</div>
          <div className="flex items-center gap-1">
            <button type="button" disabled={busy} className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-white/[0.05] disabled:opacity-45" title="新对话" onClick={newChat}><Plus className="size-4" /></button>
            <button type="button" className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-white/[0.05]" title="历史对话" onClick={() => setHistoryOpen(true)}><History className="size-4" /></button>
            <button type="button" disabled={busy} className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-white/[0.05] disabled:opacity-45" title="Provider 设置" onClick={() => editProvider()}><Settings2 className="size-4" /></button>
          </div>
        </header>
      ) : null}

      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-2.5 py-2">
        <Select aria-label="Agent 模型" disabled={busy} value={providerId} onChange={(event) => setProviderId(event.target.value)} className="min-w-0 flex-1 text-caption">
          {providers.length === 0 ? <option value="">未配置模型</option> : null}
          {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}
        </Select>
        <button type="button" disabled={busy} className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-white/[0.05] disabled:opacity-45" title="新对话" onClick={newChat}><Plus className="size-3.5" /></button>
        <button type="button" className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-white/[0.05]" title="历史对话" onClick={() => setHistoryOpen(true)}><History className="size-3.5" /></button>
        <button type="button" className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-white/[0.05]" title="Provider 设置" onClick={() => setSettingsOpen(true)}><Settings2 className="size-3.5" /></button>
      </div>

      {providers.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-6 text-center">
          <Bot className="size-8 text-accent-300/60" />
          <p className="text-ui leading-5 text-[var(--color-text-secondary)]">
            连接 OpenAI、DeepSeek、Anthropic、Gemini 或本地 Ollama。Agent 不只是聊天：它能直接改提示词、加图层、调参数并发起生成。
          </p>
          <Button tone="primary" onClick={() => setSettingsOpen(true)}>添加 AI Provider</Button>
          <p className="text-caption leading-4 text-[var(--color-text-tertiary)]">密钥只保存在本机应用数据目录。</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {messages.length === 0 && !streaming ? (
            <div className="rounded-lg border border-[var(--color-border-subtle)] bg-white/[0.025] p-3 text-ui leading-5 text-[var(--color-text-secondary)]">
              可以直接说：<br />“帮我写一个 3 区域的海报布局并生成”<br />“把当前提示词改得更像电影剧照”<br />“调成 1024×768、20 步再跑一次”
            </div>
          ) : null}

          {messages.filter((message) => message.role !== 'tool').map((message) => (
            <div key={message.id} className={`mb-2.5 flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[92%] rounded-lg px-2.5 py-2 text-ui leading-[17px] ${message.role === 'user' ? 'bg-accent-500/15 text-[var(--color-text)]' : 'bg-white/[0.04] text-[var(--color-text-secondary)]'}`}>
                {message.content ? <div className="whitespace-pre-wrap break-words">{message.content}</div> : null}
                {message.toolCalls?.length ? renderToolChips(message.toolCalls) : null}
                {message.role === 'assistant' && message.content ? (
                  <div className="mt-1.5 flex items-center gap-2 border-t border-white/[0.06] pt-1.5 text-caption">
                    <button type="button" className="text-accent-300" onClick={() => applyPrompt(message.content)}>写入 Prompt</button>
                    <button type="button" className="inline-flex items-center gap-1 text-[var(--color-text-tertiary)]" onClick={() => void copyText(message.content)}><Copy className="size-2.5" /> 复制</button>
                    {message.id === lastAssistantId ? (
                      <button type="button" disabled={busy} className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] disabled:opacity-45" onClick={() => void regenerate()}>重新生成</button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ))}

          {streaming ? (
            <div className="mb-2.5 flex justify-start">
              <div className="max-w-[92%] rounded-lg bg-white/[0.04] px-2.5 py-2 text-ui leading-[17px] text-[var(--color-text-secondary)]">
                {streamText ? <div className="whitespace-pre-wrap break-words">{streamText}</div> : null}
                {streamTools.length ? (
                  <div className={`space-y-1 ${streamText ? 'mt-1.5 border-t border-white/[0.06] pt-1.5' : ''}`}>
                    {streamTools.map((trace) => (
                      <div key={trace.id} className="flex items-start gap-1.5 text-caption">
                        {trace.status === 'running'
                          ? <Spinner className="mt-0.5 size-3 shrink-0" />
                          : trace.status === 'ok'
                            ? <Check className="mt-0.5 size-3 shrink-0 text-emerald-400" />
                            : <AlertCircle className="mt-0.5 size-3 shrink-0 text-red-400" />}
                        <span className="min-w-0">
                          <span className="text-[var(--color-text-secondary)]">{toolLabel(trace.name)}</span>
                          {trace.detail ? <span className="text-[var(--color-text-tertiary)]"> · {trace.detail}</span> : null}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {!streamText && !streamTools.length ? <span className="inline-flex items-center gap-2 text-caption text-[var(--color-text-tertiary)]"><Spinner className="size-3.5" /> 思考中…</span> : null}
              </div>
            </div>
          ) : null}

          <div ref={endRef} />
        </div>
      )}

      <div className="shrink-0 border-t border-[var(--color-border-subtle)] p-2.5">
        {failedText ? (
          <div className="mb-1.5 flex items-center justify-between gap-2 rounded-[5px] border border-red-500/30 bg-red-500/[0.07] px-2 py-1 text-caption">
            <span className="min-w-0 truncate text-red-200">上一条发送失败</span>
            <button type="button" className="shrink-0 text-accent-300 hover:underline" onClick={retry}>重试</button>
          </div>
        ) : null}
        <div className="mb-1.5 flex flex-wrap gap-1">
          <button type="button" disabled={busy} onClick={() => void sendText('请润色当前 Prompt，使画面更具体、更有电影感；直接写入画布。')} className="rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-micro text-[var(--color-text-secondary)] disabled:opacity-45">润色</button>
          <button type="button" disabled={busy} onClick={() => void sendText('请把当前 Prompt 翻成中文，保留画面术语；只给译文。')} className="rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-micro text-[var(--color-text-secondary)] disabled:opacity-45">译中</button>
          <button type="button" disabled={busy} onClick={() => void sendText('把当前想法拆成 3 个区域（主体、文字、背景），用 studio_add_layer 加到画布上，然后生成。')} className="rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-micro text-[var(--color-text-secondary)] disabled:opacity-45">拆段并生成</button>
        </div>
        <div className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            rows={2}
            aria-label="Agent 消息"
            placeholder="问 Agent，Enter 发送 / Shift+Enter 换行"
            className="app-input min-h-[48px] flex-1 resize-none text-ui"
          />
          <Button tone="primary" aria-label={busy ? '等待 Agent 回复' : '发送消息'} aria-busy={busy} onClick={() => void send()} disabled={busy || !input.trim()} className="h-[48px] px-2.5">
            {busy ? <Spinner /> : <Send className="size-4" />}
          </Button>
        </div>
        {studioPrompt ? <div className="mt-1 truncate text-micro text-[var(--color-text-tertiary)]">已带上当前 Prompt 作为上下文</div> : null}
      </div>

      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="对话历史" description="点击打开；双击标题重命名。" width="max-w-xl">
        <div className="max-h-[60vh] space-y-1 overflow-y-auto p-3">
          {conversations.length === 0 ? <p className="p-4 text-center text-caption text-[var(--color-text-tertiary)]">还没有对话</p> : null}
          {conversations.map((item) => (
            <div key={item.id} className="flex items-center gap-2 rounded-[6px] border border-[var(--color-border-subtle)] px-2 py-1.5">
              {renamingId === item.id ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={() => void renameConversation(item.id, renameDraft)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); void renameConversation(item.id, renameDraft) }
                    if (event.key === 'Escape') { event.preventDefault(); setRenamingId(null) }
                  }}
                  className="min-w-0 flex-1 rounded-[3px] bg-black/35 px-1.5 py-1 text-caption outline-none"
                />
              ) : (
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => void openConversation(item.id)}
                  onDoubleClick={() => { setRenamingId(item.id); setRenameDraft(item.title) }}
                >
                  <span className="block truncate text-caption text-[var(--color-text)]">{item.title}</span>
                  <span className="block text-micro text-[var(--color-text-tertiary)]">{new Date(item.updatedAt).toLocaleString()} · {item.messages.length} 条</span>
                </button>
              )}
              <button type="button" aria-label={`删除对话 ${item.title}`} className="shrink-0 text-[var(--color-text-tertiary)] hover:text-red-400" onClick={() => void removeConversation(item.id)}><X className="size-3.5" /></button>
            </div>
          ))}
        </div>
      </Modal>

      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="AI Provider" description="密钥只保存在本机；支持 OpenAI-compatible、Anthropic、Gemini、Ollama。工具调用需要模型支持 function calling。" width="max-w-2xl">
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
                  <button type="button" disabled={busy} aria-label={`删除 ${provider.name}`} className="text-red-300 disabled:opacity-45" onClick={() => void removeProvider(provider.id)}><Trash2 className="size-2.5" /></button>
                </span>
              ))}
            </div>
            <Button tone="primary" onClick={() => void saveProvider()}>保存 Provider</Button>
          </div>
          {presetKind.length > 0 ? <p className="col-span-2 text-caption text-[var(--color-text-tertiary)]">选择预设只会填充地址和模型，仍需填 API Key。</p> : null}
        </div>
      </Modal>

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
