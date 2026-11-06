import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderKind, AiStreamEvent, AiToolCall, AiToolDefinition, AiToolResult } from '@shared/ai'
import { useTempDataRoot } from '@test/helpers/tempDir'

const root = useTempDataRoot()
const store = () => JSON.parse(readFileSync(join(root(), 'ai', 'agent.json'), 'utf8'))
type Reply = (url: string, body: Record<string, unknown>) => Response
let replies: Reply[] = []
let requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []

beforeEach(() => {
  vi.resetModules()
  replies = []
  requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: { headers: Record<string, string>; body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>
      requests.push({ url: String(input), headers: init.headers, body })
      const reply = replies.shift()
      if (!reply) throw new Error('no reply queued')
      return reply(String(input), body)
    }),
  )
})
const load = () => import('@main/services/ai')

const tools: AiToolDefinition[] = [
  { name: 'studio_read_context', description: 'Read', inputSchema: { type: 'object' } } as AiToolDefinition,
]
const sse = (events: unknown[]) =>
  new Response(events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })

async function provider(kind: AiProviderKind, apiKey = 'sk-test') {
  const api = await load()
  const saved = api.saveProvider({ name: kind, kind, baseUrl: 'https://llm.example.test/', model: 'm', apiKey })
  return { api, id: saved.id }
}

function run(
  api: Awaited<ReturnType<typeof load>>,
  input: Parameters<Awaited<ReturnType<typeof load>>['chat']>[0],
  toolResult: AiToolResult = { ok: true, content: '{"ok":1}' },
) {
  const events: AiStreamEvent[] = []
  const calls: AiToolCall[] = []
  const promise = api.chat(input, {
    emit: (event) => events.push(event),
    runTool: async (call) => {
      calls.push(call)
      return toolResult
    },
    tools,
  })
  return { promise, events, calls }
}

describe('providers', () => {
  it('saves trimmed providers, hides keys and keeps an existing key on edit', async () => {
    const api = await load()
    const saved = api.saveProvider({ name: '  ', kind: 'openai', baseUrl: 'https://x/v1/', model: ' gpt ', apiKey: ' sk ' })
    expect(saved).toMatchObject({ name: 'Custom', baseUrl: 'https://x/v1', model: 'gpt', temperature: 0.7, hasKey: true })
    expect('apiKey' in saved).toBe(false)
    const edited = api.saveProvider({ id: saved.id, name: 'Mine', kind: 'openai', baseUrl: 'https://x/v1', model: 'gpt', temperature: 0 })
    expect(edited).toMatchObject({ name: 'Mine', temperature: 0, hasKey: true })
    expect(api.getProviderSecret(saved.id)).toEqual({ kind: 'openai', baseUrl: 'https://x/v1', model: 'gpt', apiKey: 'sk' })
    expect(api.listProviders()).toHaveLength(1)
    api.removeProvider(saved.id)
    expect(api.listProviders()).toEqual([])
    expect(api.getProviderSecret(saved.id)).toBeNull()
  })

  it('treats a corrupt or partial store as empty', async () => {
    mkdirSync(join(root(), 'ai'), { recursive: true })
    writeFileSync(join(root(), 'ai', 'agent.json'), '{')
    expect((await load()).listProviders()).toEqual([])
    writeFileSync(join(root(), 'ai', 'agent.json'), '{"providers":{}}')
    expect((await load()).listConversations()).toEqual([])
  })
})

describe('chat with an OpenAI-compatible provider', () => {
  it('streams deltas, saves the conversation and authenticates with a bearer key', async () => {
    const { api, id } = await provider('openai')
    replies.push(() =>
      sse([{ choices: [{ delta: { content: 'Hel' } }] }, 'not json', { choices: [{ delta: { content: 'lo ' } }] }, '[DONE]']),
    )
    const { promise, events } = run(api, { providerId: id, message: 'Hi there', context: 'Canvas: 1024²' })
    const result = await promise
    expect(result.reply).toBe('Hello')
    expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'delta', 'done'])
    expect(requests[0]!.url).toBe('https://llm.example.test/chat/completions')
    expect(requests[0]!.headers['authorization']).toBe('Bearer sk-test')
    const messages = requests[0]!.body['messages'] as Array<{ role: string; content: string }>
    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content.endsWith('Canvas: 1024²')).toBe(true)
    expect(messages[1]).toEqual({ role: 'user', content: 'Hi there' })
    expect((requests[0]!.body['tools'] as unknown[])[0]).toEqual({
      type: 'function',
      function: { name: 'studio_read_context', description: 'Read', parameters: { type: 'object' } },
    })
    expect(result.conversation).toMatchObject({ title: 'Hi there', providerId: id })
    expect(result.conversation.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(store().conversations).toHaveLength(1)
  })

  it('assembles streamed tool calls, runs them and sends results back', async () => {
    const { api, id } = await provider('openai', '')
    replies.push(() =>
      sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'studio_', arguments: '{"a"' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read_context', arguments: ':1}' } }] } }] },
      ]),
    )
    replies.push(() => sse([{ choices: [{ delta: { content: 'Done.' } }] }]))
    const { promise, events, calls } = run(api, { providerId: id, message: 'look' })
    const result = await promise
    expect(calls).toEqual([{ id: 'call_1', name: 'studio_read_context', arguments: '{"a":1}' }])
    expect(events.map((event) => event.type)).toEqual(['start', 'tool', 'tool-result', 'delta', 'done'])
    expect(requests[0]!.headers['authorization']).toBeUndefined()
    const second = requests[1]!.body['messages'] as Array<Record<string, unknown>>
    expect(second.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'studio_read_context', arguments: '{"a":1}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":1}' },
    ])
    expect(result.conversation.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(result.reply).toBe('Done.')
  })

  it('handles non-streaming JSON replies', async () => {
    const { api, id } = await provider('openai')
    replies.push(() => Response.json({ choices: [{ message: { content: ' plain ', tool_calls: [] } }] }))
    expect((await run(api, { providerId: id, message: 'x' }).promise).reply).toBe('plain')
  })

  it('stops after four tool rounds', async () => {
    const { api, id } = await provider('openai')
    for (let index = 0; index < 4; index += 1) {
      replies.push(() =>
        Response.json({
          choices: [{ message: { content: '', tool_calls: [{ id: `c${index}`, function: { name: 'studio_read_context' } }] } }],
        }),
      )
    }
    const { promise, calls } = run(api, { providerId: id, message: 'loop' })
    await promise
    expect(calls).toHaveLength(4)
    expect(requests).toHaveLength(4)
  })

  it('emits an error event, rethrows and does not save on HTTP errors', async () => {
    const { api, id } = await provider('openai')
    replies.push(() => Response.json({ error: { message: 'invalid key' } }, { status: 401 }))
    const { promise, events } = run(api, { providerId: id, message: 'x' })
    await expect(promise).rejects.toThrow('invalid key')
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'invalid key' })
    expect(store().conversations).toEqual([])
  })
})

describe('chat with other providers', () => {
  it('maps tool turns into Anthropic blocks, merging consecutive user content', async () => {
    const { api, id } = await provider('anthropic')
    replies.push(() =>
      Response.json({
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 'tu_1', name: 'studio_read_context', input: { x: 1 } },
        ],
      }),
    )
    replies.push(() => Response.json({ content: [{ type: 'text', text: 'All set.' }] }))
    const result = await run(api, { providerId: id, message: 'check' }).promise
    expect(requests[0]!.url).toBe('https://llm.example.test/v1/messages')
    expect(requests[0]!.headers).toMatchObject({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' })
    expect(requests[0]!.body['system']).toEqual(expect.stringContaining('MossStudio'))
    expect(requests[1]!.body['messages']).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'check' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 'tu_1', name: 'studio_read_context', input: { x: 1 } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"ok":1}' }] },
    ])
    expect(result.reply).toBe('All set.')
  })

  it('maps tool turns into Gemini contents and puts the key in the query', async () => {
    const { api, id } = await provider('gemini', 'g k')
    replies.push(() =>
      Response.json({ candidates: [{ content: { parts: [{ functionCall: { name: 'studio_read_context', args: { y: 2 } } }] } }] }),
    )
    replies.push(() => Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }))
    await run(api, { providerId: id, message: 'go' }).promise
    expect(requests[0]!.url).toBe('https://llm.example.test/models/m:generateContent?key=g%20k')
    expect(requests[1]!.body['contents']).toEqual([
      { role: 'user', parts: [{ text: 'go' }] },
      { role: 'model', parts: [{ functionCall: { name: 'studio_read_context', args: { y: 2 } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'studio_read_context', response: { content: '{"ok":1}' } } }] },
    ])
  })

  it('sends Ollama a flat message list without tools', async () => {
    const { api, id } = await provider('ollama')
    replies.push(() => Response.json({ message: { content: ' hi ' } }))
    expect((await run(api, { providerId: id, message: 'yo' }).promise).reply).toBe('hi')
    expect(requests[0]!.url).toBe('https://llm.example.test/api/chat')
    expect(requests[0]!.body).toMatchObject({ stream: false, messages: [{ role: 'system' }, { role: 'user', content: 'yo' }] })
    expect(requests[0]!.body['tools']).toBeUndefined()
  })

  it('surfaces provider error messages', async () => {
    const { api, id } = await provider('ollama')
    replies.push(() => Response.json({ error: 'model not found' }, { status: 404 }))
    await expect(run(api, { providerId: id, message: 'x' }).promise).rejects.toThrow('model not found')
  })
})

describe('conversations', () => {
  it('continues, regenerates, renames and removes conversations', async () => {
    const { api, id } = await provider('ollama')
    replies.push(() => Response.json({ message: { content: 'one' } }))
    const first = await run(api, { providerId: id, message: 'first message' }).promise
    replies.push(() => Response.json({ message: { content: 'two' } }))
    const second = await run(api, { providerId: id, conversationId: first.conversation.id, message: 'again' }).promise
    expect(second.conversation.messages.map((message) => message.content)).toEqual(['first message', 'one', 'again', 'two'])
    expect(second.conversation.title).toBe('first message')
    replies.push(() => Response.json({ message: { content: 'two, better' } }))
    const regenerated = await run(api, { providerId: id, conversationId: first.conversation.id, regenerate: true }).promise
    expect(regenerated.conversation.messages.map((message) => message.content)).toEqual(['first message', 'one', 'again', 'two, better'])
    expect(api.listConversations()).toHaveLength(1)
    expect(api.renameConversation(first.conversation.id, `  ${'x'.repeat(200)}  `)!.title).toHaveLength(120)
    expect(api.renameConversation(first.conversation.id, '   ')!.title).toHaveLength(120)
    expect(api.renameConversation('missing', 'x')).toBeNull()
    api.removeConversation(first.conversation.id)
    expect(api.listConversations()).toEqual([])
  })

  it('refuses unknown providers and regenerating an empty conversation', async () => {
    const { api, id } = await provider('ollama')
    await expect(run(api, { providerId: 'missing', message: 'x' }).promise).rejects.toThrow('请先添加 AI Provider')
    await expect(run(api, { providerId: id, regenerate: true }).promise).rejects.toThrow('没有可重新生成的对话')
  })

  it('truncates long titles to 48 characters and lists newest first', async () => {
    const { api, id } = await provider('ollama')
    replies.push(
      () => Response.json({ message: { content: 'a' } }),
      () => Response.json({ message: { content: 'b' } }),
    )
    const older = await run(api, { providerId: id, message: 'y'.repeat(100) }).promise
    expect(older.conversation.title).toHaveLength(48)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const newer = await run(api, { providerId: id, message: 'newer' }).promise
    expect(api.listConversations().map((item) => item.id)).toEqual([newer.conversation.id, older.conversation.id])
    expect(api.AI_PROVIDER_KINDS).toEqual(['openai', 'anthropic', 'gemini', 'ollama'])
  })
})
