import { AlertCircle, ArrowUp, Check, History, Plus, Settings2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type { AiConversationInfo, AiMessage, AiProviderInfo, AiStreamEvent, AiToolCall } from '@shared/ai'
import { Button, IconButton, Input, MarkdownBody, Modal, Select, Spinner, cn, useCopyText, useToast } from '../../../components/ui'
import { useUiAnimationEnabled } from '../../../components/motion'
import { call, onEvent } from '../../../lib/api'
import { applyStudioDescription, formatStudioContext, readStudioSnapshot } from '../../../lib/agentTools'
import { relative } from '../../../lib/format'
import { ProviderDialog } from './ProviderDialog'
import { toolDetail, toolLabel } from './format'

/** Survives unmounts so the chat never loses its place. */
const CONVERSATION_KEY = 'mossstudio.agentConversationId'

function readStored(): string | null {
  try {
    return localStorage.getItem(CONVERSATION_KEY)
  } catch {
    return null
  }
}

function writeStored(id: string | null): void {
  try {
    if (id) localStorage.setItem(CONVERSATION_KEY, id)
    else localStorage.removeItem(CONVERSATION_KEY)
  } catch {
    // Remembering the conversation is a convenience only.
  }
}

interface ToolTrace {
  id: string
  name: string
  status: 'running' | 'ok' | 'error'
  detail: string
}

const SUGGESTIONS = [
  { label: '润色描述', text: '请润色当前画面的描述，让画面更具体、更有氛围，直接写回描述。' },
  { label: '拆成区域', text: '根据当前描述，把画面拆成 2–3 个区域（主体、文字、背景等），用工具加到画面上。' },
  { label: '写一句描述', text: '帮我为当前画面写一句完整的描述，直接写回描述。' },
]

function ToolLine({ status, name, detail }: { status: ToolTrace['status']; name: string; detail?: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-1.5 text-caption">
      {status === 'running' ? (
        <Spinner className="mt-0.5 size-3.5 shrink-0" />
      ) : status === 'ok' ? (
        <Check className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden="true" />
      ) : (
        <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
      )}
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="text-ink">{toolLabel(name)}</span>
        {detail ? <span className="text-ink-2"> · {detail}</span> : null}
      </span>
    </div>
  )
}

/**
 * The Studio assistant. Every message carries the selected canvas as it is at
 * the moment of sending (description and regions), and the assistant changes
 * the canvas through the studio_* tools.
 */
export function Assistant(): React.JSX.Element {
  const toast = useToast()
  const copyText = useCopyText()
  const animate = useUiAnimationEnabled()
  const [providers, setProviders] = useState<AiProviderInfo[]>([])
  const [providerId, setProviderId] = useState('')
  const [conversations, setConversations] = useState<AiConversationInfo[]>([])
  const [conversation, setConversation] = useState<AiConversationInfo | null>(null)
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const [failedText, setFailedText] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [streamTools, setStreamTools] = useState<ToolTrace[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [proposal, setProposal] = useState<{ current: string; next: string } | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  async function refresh(): Promise<void> {
    try {
      const [nextProviders, nextConversations] = await Promise.all([
        call<AiProviderInfo[]>(Ipc.aiProvidersList),
        call<AiConversationInfo[]>(Ipc.aiConversations),
      ])
      setProviders(nextProviders)
      setProviderId((current) => (nextProviders.some((provider) => provider.id === current) ? current : nextProviders[0]?.id || ''))
      setConversations(nextConversations)
    } catch {
      // Keep what is on screen.
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  // Reopen the conversation the user was in before this panel last unmounted.
  useEffect(() => {
    const saved = readStored()
    if (!saved || conversation || conversations.length === 0) return
    const next = conversations.find((item) => item.id === saved)
    if (!next) return
    setConversation(next)
    setMessages(next.messages)
    if (next.providerId) setProviderId(next.providerId)
  }, [conversations, conversation])

  useEffect(() => {
    if (conversation?.id) writeStored(conversation.id)
  }, [conversation?.id])

  useEffect(
    () =>
      onEvent<AiStreamEvent>(Events.aiStream, (event) => {
        if (event.type === 'start') {
          setStreaming(true)
          setStreamText('')
          setStreamTools([])
        } else if (event.type === 'delta') {
          setStreamText((current) => current + event.text)
        } else if (event.type === 'tool') {
          setStreamTools((current) => [...current, { id: event.call.id, name: event.call.name, status: 'running', detail: '' }])
        } else if (event.type === 'tool-result') {
          setStreamTools((current) =>
            current.map((trace) =>
              trace.id === event.callId
                ? { ...trace, status: event.result.ok ? 'ok' : 'error', detail: toolDetail(event.result.content) }
                : trace,
            ),
          )
        } else if (event.type === 'done') {
          setConversation(event.conversation)
          setMessages(event.conversation.messages)
          setStreaming(false)
          setStreamText('')
          setStreamTools([])
          void refresh()
        } else if (event.type === 'error') {
          setStreaming(false)
          toast.push(event.message, 'error')
        }
      }),
    [toast],
  )

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest', behavior: animate ? 'smooth' : 'instant' })
  }, [messages, busy, streamText, streamTools.length, animate])

  async function chat(payload: { message?: string; regenerate?: boolean }): Promise<boolean> {
    try {
      const result = await call<{ reply: string; conversation: AiConversationInfo }>(Ipc.aiChat, {
        providerId,
        conversationId: conversation?.id,
        ...payload,
        // Read at send time: the canvas as it is now, not when the panel rendered.
        context: formatStudioContext(readStudioSnapshot()),
      })
      setConversation(result.conversation)
      setMessages(result.conversation.messages)
      await refresh()
      return true
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
      return false
    }
  }

  async function sendText(raw: string, fromComposer = false): Promise<void> {
    if (sending.current) return
    if (!providerId) {
      setSettingsOpen(true)
      return
    }
    const text = raw.trim()
    if (!text) return
    sending.current = true
    setMessages((current) => [...current, { id: `local-${Date.now()}`, role: 'user', content: text, createdAt: new Date().toISOString() }])
    setFailedText(null)
    if (fromComposer) setInput('')
    setBusy(true)
    const ok = await chat({ message: text })
    if (!ok) {
      setFailedText(text)
      if (fromComposer) setInput((current) => current || text)
    }
    sending.current = false
    setBusy(false)
  }

  async function regenerate(): Promise<void> {
    if (sending.current || !providerId || !conversation?.id) return
    sending.current = true
    setBusy(true)
    setFailedText(null)
    await chat({ regenerate: true })
    sending.current = false
    setBusy(false)
  }

  function newChat(): void {
    if (sending.current) return
    writeStored(null)
    setConversation(null)
    setMessages([])
    setInput('')
    setFailedText(null)
    setStreaming(false)
    setStreamText('')
    setStreamTools([])
  }

  async function renameConversation(id: string, title: string): Promise<void> {
    setRenamingId(null)
    if (!title.trim()) return
    try {
      const next = await call<AiConversationInfo | null>(Ipc.aiConversationRename, { id, title: title.trim() })
      if (next && conversation?.id === id) setConversation(next)
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

  function proposeDescription(text: string): void {
    const snapshot = readStudioSnapshot()
    if (!snapshot) {
      toast.push('先在画布上选中一个画面', 'info')
      return
    }
    setProposal({ current: snapshot.description, next: text.trim() })
  }

  const lastAssistantId = [...messages].reverse().find((message) => message.role === 'assistant')?.id
  const toolResults = useMemo(() => {
    const map = new Map<string, AiMessage>()
    for (const message of messages) if (message.role === 'tool' && message.toolCallId) map.set(message.toolCallId, message)
    return map
  }, [messages])

  function renderToolCalls(calls: AiToolCall[]): React.JSX.Element {
    return (
      <div className="flex flex-col gap-1 rounded-lg bg-well px-2.5 py-2">
        {calls.map((item) => {
          const result = toolResults.get(item.id)
          return (
            <ToolLine
              key={item.id}
              name={item.name}
              status={!result ? 'running' : result.error ? 'error' : 'ok'}
              detail={result ? toolDetail(result.content) : undefined}
            />
          )
        })}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1">
        <Select
          aria-label="语言模型"
          disabled={busy || providers.length === 0}
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
          className="h-8 min-w-0 flex-1 text-ui"
        >
          {providers.length === 0 ? <option value="">还没有连接语言模型</option> : null}
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name} · {provider.model}
            </option>
          ))}
        </Select>
        <IconButton label="新对话" disabled={busy} onClick={newChat}>
          <Plus className="size-4" />
        </IconButton>
        <IconButton label="历史对话" onClick={() => setHistoryOpen(true)}>
          <History className="size-4" />
        </IconButton>
        <IconButton label="连接设置" onClick={() => setSettingsOpen(true)}>
          <Settings2 className="size-4" />
        </IconButton>
      </div>

      {providers.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <p className="text-ui text-ink-2">连接一个语言模型服务后，助手可以帮你写描述、把画面拆成区域、调整参数并开始生成。</p>
          <Button tone="primary" size="md" onClick={() => setSettingsOpen(true)}>
            连接语言模型
          </Button>
          <p className="text-caption text-ink-2">支持 OpenAI、DeepSeek、Anthropic、Gemini 和本地 Ollama。</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto py-4">
          {messages.length === 0 && !streaming ? (
            <div className="flex flex-col gap-2 text-ui text-ink-2">
              <p>助手看得到当前选中的画面。可以直接说：</p>
              <p className="text-ink">“做一张三段式的春季海报，标题写 SPRING”</p>
              <p className="text-ink">“把描述改得更像电影剧照”</p>
              <p className="text-ink">“换成 16:9，精细质量再跑一次”</p>
            </div>
          ) : null}

          <div className="flex flex-col gap-4">
            {messages
              .filter((message) => message.role !== 'tool')
              .map((message) =>
                message.role === 'user' ? (
                  <div key={message.id} className="ml-6 self-end rounded-lg bg-well px-3 py-2 text-ui text-ink">
                    <div className="selectable whitespace-pre-wrap break-words">{message.content}</div>
                  </div>
                ) : (
                  <div key={message.id} className="flex flex-col gap-2">
                    {message.content ? <MarkdownBody>{message.content}</MarkdownBody> : null}
                    {message.toolCalls?.length ? renderToolCalls(message.toolCalls) : null}
                    {message.role === 'assistant' && message.content ? (
                      <div className="-ml-2 flex items-center gap-0.5">
                        <Button
                          tone="ghost"
                          size="sm"
                          className="h-7 px-2 text-caption"
                          onClick={() => proposeDescription(message.content)}
                        >
                          用作描述
                        </Button>
                        <Button tone="ghost" size="sm" className="h-7 px-2 text-caption" onClick={() => void copyText(message.content)}>
                          复制
                        </Button>
                        {message.id === lastAssistantId ? (
                          <Button
                            tone="ghost"
                            size="sm"
                            className="h-7 px-2 text-caption"
                            disabled={busy}
                            onClick={() => void regenerate()}
                          >
                            重新回答
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ),
              )}

            {streaming ? (
              <div className="flex flex-col gap-2">
                {streamText ? <MarkdownBody>{streamText}</MarkdownBody> : null}
                {streamTools.length ? (
                  <div className="flex flex-col gap-1 rounded-lg bg-well px-2.5 py-2">
                    {streamTools.map((trace) => (
                      <ToolLine key={trace.id} name={trace.name} status={trace.status} detail={trace.detail} />
                    ))}
                  </div>
                ) : null}
                {!streamText && !streamTools.length ? (
                  <span className="inline-flex items-center gap-2 text-caption text-ink-2">
                    <Spinner className="size-3.5" />
                    思考中…
                  </span>
                ) : null}
              </div>
            ) : busy ? (
              <span className="inline-flex items-center gap-2 text-caption text-ink-2">
                <Spinner className="size-3.5" />
                思考中…
              </span>
            ) : null}
          </div>
          <div ref={endRef} />
        </div>
      )}

      <div className="flex shrink-0 flex-col gap-2 pt-2">
        {failedText ? (
          <div className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-1.5 text-caption">
            <span className="min-w-0 flex-1 truncate text-danger">上一条没有发出去</span>
            <Button
              tone="ghost"
              size="sm"
              className="h-6 px-2"
              onClick={() => {
                const text = failedText
                setFailedText(null)
                void sendText(text)
              }}
            >
              重试
            </Button>
          </div>
        ) : null}
        {providers.length ? (
          <div className="flex flex-wrap gap-1">
            {SUGGESTIONS.map((item) => (
              <Button
                key={item.label}
                tone="secondary"
                size="sm"
                className="h-7 px-2.5 text-caption"
                disabled={busy}
                onClick={() => void sendText(item.text)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        ) : null}
        <div className="relative">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
                event.preventDefault()
                void sendText(input, true)
              }
            }}
            rows={3}
            aria-label="给助手的消息"
            placeholder="说说你想要的画面…"
            className="ui-field ui-textarea min-h-[84px] resize-none pb-10 pr-3"
          />
          <IconButton
            label={busy ? '等待助手回复' : '发送'}
            aria-busy={busy}
            disabled={busy || !input.trim()}
            onClick={() => void sendText(input, true)}
            className={cn(
              'absolute bottom-2 right-2 size-7 bg-ink text-on-ink enabled:hover:bg-ink enabled:hover:text-on-ink enabled:hover:opacity-90',
            )}
          >
            {busy ? <Spinner className="size-3.5" /> : <ArrowUp className="size-4" />}
          </IconButton>
        </div>
        <p className="text-micro text-ink-2">Enter 发送，Shift+Enter 换行</p>
      </div>

      <Modal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title="历史对话"
        description="点击打开，双击标题可以重命名。"
        width="max-w-xl"
      >
        <div className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto">
          {conversations.length === 0 ? <p className="py-6 text-center text-caption text-ink-2">还没有对话</p> : null}
          {conversations.map((item) => (
            <div
              key={item.id}
              className={cn('flex items-center gap-2 rounded-lg py-1 pl-3 pr-1 hover:bg-well', item.id === conversation?.id && 'bg-well')}
            >
              {renamingId === item.id ? (
                <Input
                  autoFocus
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={() => void renameConversation(item.id, renameDraft)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void renameConversation(item.id, renameDraft)
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setRenamingId(null)
                    }
                  }}
                  className="h-8"
                />
              ) : (
                <button
                  type="button"
                  className="min-w-0 flex-1 py-1 text-left"
                  onClick={() => {
                    if (sending.current) return
                    setConversation(item)
                    setMessages(item.messages)
                    if (item.providerId) setProviderId(item.providerId)
                    setHistoryOpen(false)
                  }}
                  onDoubleClick={() => {
                    setRenamingId(item.id)
                    setRenameDraft(item.title)
                  }}
                >
                  <span className="block truncate text-ui text-ink">{item.title}</span>
                  <span className="block text-caption text-ink-2">
                    {relative(item.updatedAt)} · {item.messages.length} 条
                  </span>
                </button>
              )}
              <IconButton label={`删除对话 ${item.title}`} onClick={() => void removeConversation(item.id)}>
                <X className="size-4" />
              </IconButton>
            </div>
          ))}
        </div>
      </Modal>

      <ProviderDialog open={settingsOpen} providers={providers} busy={busy} onClose={() => setSettingsOpen(false)} onChanged={refresh} />

      <Modal
        open={proposal !== null}
        onClose={() => setProposal(null)}
        title="替换描述？"
        description="把助手的这段回答写进当前画面的描述。"
        width="max-w-2xl"
        footer={
          <>
            <Button tone="ghost" size="md" onClick={() => setProposal(null)}>
              取消
            </Button>
            <Button
              tone="primary"
              size="md"
              onClick={() => {
                if (proposal && applyStudioDescription(proposal.next)) toast.push('描述已更新', 'success')
                else toast.push('先在画布上选中一个可编辑的画面', 'info')
                setProposal(null)
              }}
            >
              替换描述
            </Button>
          </>
        }
      >
        {proposal ? (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <div className="text-caption font-medium text-ink-2">现在</div>
              <p className="selectable max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-panel p-3 text-ui text-ink-2">
                {proposal.current || '（空）'}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-caption font-medium text-ink-2">替换为</div>
              <p className="selectable max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-panel p-3 text-ui text-ink">
                {proposal.next}
              </p>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
