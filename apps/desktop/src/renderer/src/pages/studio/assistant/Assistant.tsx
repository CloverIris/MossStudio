import { ArrowUp, ChevronDown, Copy, History, PenLine, Plus, RotateCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type { AgentMode, AiConversationInfo, AiMessage, AiProviderInfo, AiStreamEvent, AiToolCall } from '@shared/ai'
import { Notice } from '../../../components/common/Notice'
import { MenuGap, MenuItem, Popover } from '../../../components/common/Popover'
import {
  Button,
  cn,
  ConfirmDialog,
  EmptyState,
  FieldLabel,
  IconButton,
  Input,
  MarkdownBody,
  Modal,
  Segmented,
  Spinner,
  useCopyText,
  useToast,
} from '../../../components/ui'
import { useUiAnimationEnabled } from '../../../components/motion'
import { useShell } from '../../../lib/shell'
import { call, onEvent } from '../../../lib/api'
import { applyPlan, applyStudioDescription, formatStudioContext, readStudioSnapshot } from '../../../lib/agentTools'
import { relative } from '../../../lib/format'
import type { AgentCard, AgentCardAnswer } from '@shared/agent/cards'
import { ChoiceCard } from './ChoiceCard'
import { ConfirmCard } from './ConfirmCard'
import { PlanCard } from './PlanCard'
import { ProviderDialog } from './ProviderDialog'
import { ToolTrace, type TraceEntry } from './ToolTrace'
import { toolDetail } from './format'

/** Survives unmounts so the chat never loses its place. */
const CONVERSATION_KEY = 'mossstudio.agentConversationId'
/** Last mode the user picked; a new conversation starts with it. */
const MODE_KEY = 'mossstudio.agentMode'

/** 自主 acts on its own; 审批 turns every write into a plan to approve first. */
const MODES: Array<{ value: AgentMode; label: string; hint: string }> = [
  { value: 'auto', label: '自主', hint: '自主：直接执行改动，只在必须由你决定时问一句' },
  { value: 'advanced', label: '审批', hint: '审批：先给出方案，你批准后才执行' },
]

function readMode(): AgentMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'advanced' ? 'advanced' : 'auto'
  } catch {
    return 'auto'
  }
}

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

interface StreamTrace {
  id: string
  name: string
  status: 'running' | 'ok' | 'error'
  detail: string
}

const SUGGESTIONS = [
  { label: '润色描述', text: '请润色当前画面的描述，让画面更具体、更有氛围，直接写回描述。' },
  { label: '拆成区域', text: '根据当前描述，把画面拆成 2–3 个区域（主体、文字、背景等），用工具加到画面上。' },
  { label: '做一套分镜', text: '帮我做一套 6 镜的分镜：先问我主题，再一次建好这些画面。' },
]

function followUpFor(card: AgentCard, answer: AgentCardAnswer, problems: string[]): string {
  if (answer.applied) {
    const steps = card.steps ?? []
    const shown = steps
      .slice(0, 3)
      .map((step) => step.label)
      .join('、')
    const done = shown ? `已执行方案：${shown}${steps.length > 3 ? ` 等 ${steps.length} 处` : ''}` : `已执行方案（${steps.length} 处）`
    // Say the plan is done, so the model does not ask the user to confirm it again.
    return problems.length ? `${done}。还差：${problems[0]}` : `${done}，已经生效，不用再确认。`
  }
  if (card.kind === 'plan' && answer.freeText?.trim()) return `方案先不应用，改一下：${answer.freeText.trim()}`
  if (card.kind === 'confirm') {
    if (answer.freeText?.trim()) return `先改一下：${answer.freeText.trim()}`
    return answer.selected.includes('approve') ? '批准，开始吧。' : '先别做。'
  }
  if (answer.skipped) return `「${card.title}」先跳过，你按默认继续。`
  const labels = (card.options ?? []).filter((option) => answer.selected.includes(option.id)).map((option) => option.label)
  const lines = [labels.length ? labels.join('、') : answer.freeText?.trim() ? '' : '就按这个来。'].filter(Boolean)
  if (answer.freeText?.trim()) lines.push(labels.length ? `补充：${answer.freeText.trim()}` : answer.freeText.trim())
  return lines.join('\n')
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
  const [mode, setMode] = useState<AgentMode>(readMode)
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [answering, setAnswering] = useState(false)
  const sending = useRef(false)
  const [failedText, setFailedText] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [streamTools, setStreamTools] = useState<StreamTrace[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [removingChat, setRemovingChat] = useState<AiConversationInfo | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [proposal, setProposal] = useState<{ current: string; next: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollFrame = useRef(0)
  const [activeTurn, setActiveTurn] = useState(0)
  const composer = useRef<HTMLTextAreaElement>(null)
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

  // A conversation remembers the mode it was used in; a new one starts with the last pick.
  useEffect(() => {
    if (conversation?.mode) setMode(conversation.mode)
  }, [conversation?.id, conversation?.mode])

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
        mode,
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

  function changeMode(next: AgentMode): void {
    if (next === mode) return
    setMode(next)
    try {
      localStorage.setItem(MODE_KEY, next)
    } catch {
      // Remembering the mode is a convenience only.
    }
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

  /**
   * A confirmed plan is applied here, by the same handlers a direct tool call
   * would use, before the answer is stored; then the answer becomes the next
   * user message, which is what continues the conversation.
   */
  async function answerCard(message: AiMessage, answer: AgentCardAnswer): Promise<void> {
    const card = message.card
    if (!card || !conversation?.id || sending.current || answering) return
    setAnswering(true)
    let problems: string[] = []
    try {
      if (answer.applied) problems = (await applyPlan(card)).problems
      const next = await call<AiConversationInfo>(Ipc.aiCardAnswer, { conversationId: conversation.id, messageId: message.id, answer })
      setConversation(next)
      setMessages(next.messages)
      await sendText(followUpFor(card, answer, problems))
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setAnswering(false)
    }
  }

  const lastAssistantId = [...messages].reverse().find((message) => message.role === 'assistant')?.id
  const toolResults = useMemo(() => {
    const map = new Map<string, AiMessage>()
    for (const message of messages) if (message.role === 'tool' && message.toolCallId) map.set(message.toolCallId, message)
    return map
  }, [messages])

  /** One entry per call, with the result folded into a single line. */
  function traceOf(calls: AiToolCall[]): TraceEntry[] {
    return calls.map((item) => {
      const result = toolResults.get(item.id)
      return {
        id: item.id,
        name: item.name,
        status: result ? (result.error ? 'error' : 'ok') : 'ok',
        detail: result ? toolDetail(result.content) : undefined,
      }
    })
  }

  /** The card the user still has to answer; it sits in the dock, never in the scroll flow. */
  const pendingCard = useMemo(() => [...messages].reverse().find((message) => message.card && !message.card.answer) ?? null, [messages])

  // A plan waiting for 审批 shows its boxes on the selected 画面 until it is answered.
  const setPlanPreview = useShell((state) => state.setPlanPreview)
  const planSteps = pendingCard?.card?.kind === 'plan' ? pendingCard.card.steps : undefined
  useEffect(() => {
    setPlanPreview(planSteps?.length ? planSteps : null)
  }, [planSteps, setPlanPreview])
  useEffect(() => () => setPlanPreview(null), [setPlanPreview])

  /** Typing while a card waits answers it: a question's own words, a plan's or a go/no-go's change of mind. */
  function submit(): void {
    const text = input.trim()
    if (!text) return
    if (pendingCard && !busy && !answering) {
      setInput('')
      void answerCard(pendingCard, { selected: [], freeText: text })
      return
    }
    void sendText(input, true)
  }

  /** One anchor per user turn, for the rail on the right. */
  const turns = useMemo(
    () =>
      messages.filter((message) => message.role === 'user').map((message, index) => ({ id: message.id, index, label: message.content })),
    [messages],
  )

  function jumpToTurn(id: string): void {
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
    target?.scrollIntoView({ block: 'start', behavior: animate ? 'smooth' : 'auto' })
  }

  const onScroll = useCallback((): void => {
    if (scrollFrame.current) return
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0
      const container = scrollRef.current
      if (!container) return
      const edge = container.getBoundingClientRect().top + 32
      let active = 0
      turns.forEach((turn, index) => {
        const element = container.querySelector<HTMLElement>(`[data-message-id="${turn.id}"]`)
        if (element && element.getBoundingClientRect().top <= edge) active = index
      })
      setActiveTurn(active)
    })
  }, [turns])

  // Keep the rail in step when the conversation grows or shrinks under it.
  useEffect(() => {
    const frame = requestAnimationFrame(onScroll)
    return () => cancelAnimationFrame(frame)
  }, [onScroll, messages.length])

  const composerHint =
    pendingCard?.card?.kind === 'choice'
      ? '或者直接写你的答案…'
      : pendingCard?.card?.kind === 'plan'
        ? '想改哪里？写给助手…'
        : pendingCard?.card?.kind === 'confirm'
          ? '想先改什么？写给助手…'
          : '说说你想要的画面…'

  function renderCard(message: AiMessage): React.JSX.Element | null {
    const card = message.card
    if (!card) return null
    const onAnswer = (answer: AgentCardAnswer): void => void answerCard(message, answer)
    const shared = { card, busy: busy || answering, onAnswer, onReply: () => composer.current?.focus() }
    if (card.kind === 'plan') return <PlanCard {...shared} />
    if (card.kind === 'confirm') return <ConfirmCard {...shared} />
    return <ChoiceCard {...shared} />
  }

  const provider = providers.find((item) => item.id === providerId)
  const answeredLine = (card: AgentCard): string => {
    if (card.kind === 'plan') {
      const steps = card.steps?.length ?? 0
      const result = card.answer?.applied ? `已应用 ${steps} 处改动` : card.answer?.skipped ? '已放弃' : '提了调整'
      return `${card.title} · ${result}`
    }
    return card.answer?.skipped ? `${card.title} · 已跳过` : card.title
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1">
        {providers.length ? (
          <Popover
            align="start"
            label="语言模型"
            className="min-w-[220px]"
            trigger={(menu) => (
              <button
                type="button"
                onClick={menu.toggle}
                aria-expanded={menu['aria-expanded']}
                aria-haspopup="menu"
                aria-label="语言模型"
                title={provider ? `${provider.name} · ${provider.model}` : undefined}
                disabled={busy}
                className="flex h-8 min-w-0 items-center gap-1 rounded-md px-2 text-ui font-semibold text-ink enabled:hover:bg-well disabled:opacity-60"
              >
                <span className="truncate">{provider?.name ?? '选择模型'}</span>
                <ChevronDown className="size-3.5 shrink-0 text-ink-2" strokeWidth={1.6} aria-hidden="true" />
              </button>
            )}
          >
            {(close) => (
              <>
                {providers.map((item) => (
                  <MenuItem
                    key={item.id}
                    selected={item.id === providerId}
                    onSelect={() => {
                      setProviderId(item.id)
                      close()
                    }}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{item.name}</span>
                      <span className="truncate text-caption text-ink-2">{item.model}</span>
                    </span>
                  </MenuItem>
                ))}
                <MenuGap />
                <MenuItem
                  onSelect={() => {
                    close()
                    setSettingsOpen(true)
                  }}
                >
                  连接设置…
                </MenuItem>
              </>
            )}
          </Popover>
        ) : null}
        <span className="min-w-0 flex-1" />
        <Segmented<AgentMode> label="助手模式" value={mode} onChange={changeMode} options={MODES} />
        <IconButton label="历史对话" onClick={() => setHistoryOpen(true)}>
          <History className="size-4" strokeWidth={1.6} />
        </IconButton>
        <IconButton label="新对话" disabled={busy} onClick={newChat}>
          <Plus className="size-4" strokeWidth={1.6} />
        </IconButton>
      </div>

      {providers.length === 0 ? (
        <EmptyState
          size="section"
          className="min-h-0 flex-1"
          title="还没有连接语言模型"
          description="支持 OpenAI、DeepSeek、Anthropic、Gemini 和本地 Ollama。"
          action={
            <Button tone="primary" size="md" onClick={() => setSettingsOpen(true)}>
              连接语言模型
            </Button>
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto py-4 pr-5">
              <div className="flex flex-col gap-4">
                {messages
                  .filter((message) => message.role !== 'tool')
                  .map((message) =>
                    message.role === 'user' ? (
                      <div
                        key={message.id}
                        data-message-id={message.id}
                        className="ml-6 self-end rounded-lg bg-well px-3 py-2 text-ui text-ink"
                      >
                        <div className="selectable whitespace-pre-wrap break-words">{message.content}</div>
                      </div>
                    ) : (
                      <div key={message.id} data-message-id={message.id} className="group/msg relative flex flex-col gap-2">
                        {message.toolCalls?.length ? <ToolTrace entries={traceOf(message.toolCalls)} /> : null}
                        {message.content ? <MarkdownBody>{message.content}</MarkdownBody> : null}
                        {/* Answered: the question in one quiet line; the answer is the user's next bubble. */}
                        {message.card?.answer ? (
                          <p data-answered-card className="text-caption text-ink-2">
                            {answeredLine(message.card)}
                          </p>
                        ) : null}
                        {message.content ? (
                          // A reply's actions float over its corner on hover; they take no room in the conversation.
                          <div
                            data-reply-actions
                            className="pointer-events-none absolute -top-3 right-0 flex items-center gap-0.5 rounded-lg bg-raised p-0.5 opacity-0 shadow-float transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover/msg:pointer-events-auto group-hover/msg:opacity-100"
                          >
                            <IconButton label="用作描述" className="size-7" onClick={() => proposeDescription(message.content)}>
                              <PenLine className="size-3.5" strokeWidth={1.6} />
                            </IconButton>
                            <IconButton label="复制" className="size-7" onClick={() => void copyText(message.content)}>
                              <Copy className="size-3.5" strokeWidth={1.6} />
                            </IconButton>
                            {message.id === lastAssistantId ? (
                              <IconButton label="重新回答" className="size-7" disabled={busy} onClick={() => void regenerate()}>
                                <RotateCw className="size-3.5" strokeWidth={1.6} />
                              </IconButton>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ),
                  )}

                {streaming ? (
                  <div className="flex flex-col gap-2">
                    {streamTools.length ? <ToolTrace entries={streamTools} /> : null}
                    {streamText ? <MarkdownBody>{streamText}</MarkdownBody> : null}
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

            {turns.length > 1 ? (
              <nav aria-label="对话轮次" className="absolute inset-y-4 right-0 flex flex-col items-center justify-center gap-1.5">
                {turns.map((turn) => (
                  <button
                    key={turn.id}
                    type="button"
                    title={turn.label.slice(0, 60)}
                    aria-label={`第 ${turn.index + 1} 轮`}
                    aria-current={activeTurn === turn.index ? 'true' : undefined}
                    onClick={() => jumpToTurn(turn.id)}
                    className={cn(
                      'w-1.5 rounded-full transition-all',
                      activeTurn === turn.index ? 'h-3 bg-accent' : 'h-1.5 bg-ink-3/40 enabled:hover:bg-ink-3/70',
                    )}
                  />
                ))}
              </nav>
            ) : null}
          </div>

          {pendingCard ? (
            // The one card waiting for an answer: raised above the input, never lost in the scroll.
            <div data-pending-card className="mb-2 shrink-0 rounded-xl bg-raised p-3 shadow-float">
              {renderCard(pendingCard)}
            </div>
          ) : null}
        </div>
      )}

      <div className="flex shrink-0 flex-col gap-2">
        {failedText ? (
          <Notice
            tone="danger"
            action={
              <Button
                size="xs"
                onClick={() => {
                  const text = failedText
                  setFailedText(null)
                  void sendText(text)
                }}
              >
                重试
              </Button>
            }
          >
            上一条没有发出去
          </Notice>
        ) : null}
        {providers.length && messages.length === 0 && !busy ? (
          // Ways to start, only while the conversation is empty.
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((item) => (
              <Button key={item.label} size="xs" onClick={() => void sendText(item.text)}>
                {item.label}
              </Button>
            ))}
          </div>
        ) : null}
        <div className="relative">
          <textarea
            ref={composer}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
                event.preventDefault()
                submit()
              }
            }}
            rows={2}
            aria-label="给助手的消息"
            placeholder={composerHint}
            className="ui-field ui-textarea min-h-[64px] resize-none pb-9 pr-3"
          />
          <IconButton
            label={busy ? '等待助手回复' : '发送'}
            aria-busy={busy}
            disabled={busy || answering || !input.trim()}
            onClick={submit}
            className="absolute bottom-2 right-2 size-7 bg-ink text-on-ink enabled:hover:bg-ink enabled:hover:text-on-ink enabled:hover:opacity-90"
          >
            {busy ? <Spinner className="size-3.5" /> : <ArrowUp className="size-4" strokeWidth={1.6} />}
          </IconButton>
        </div>
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
              {/* Deleting a conversation loses it: Trash2 and a confirm (X only unlinks). */}
              <IconButton
                label={`删除对话 ${item.title}`}
                className="text-danger enabled:hover:text-danger"
                onClick={() => setRemovingChat(item)}
              >
                <Trash2 className="size-4" strokeWidth={1.6} />
              </IconButton>
            </div>
          ))}
        </div>
      </Modal>
      <ConfirmDialog
        open={removingChat !== null}
        onClose={() => setRemovingChat(null)}
        title={`删除对话「${removingChat?.title ?? ''}」？`}
        description="这段对话的全部消息都会删除，不能恢复。"
        confirmLabel="删除对话"
        onConfirm={() => {
          if (removingChat) void removeConversation(removingChat.id)
          setRemovingChat(null)
        }}
      />

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
              <FieldLabel>现在</FieldLabel>
              <p className="selectable max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-panel p-3 text-ui text-ink-2">
                {proposal.current || '（空）'}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>替换为</FieldLabel>
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
