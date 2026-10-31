export type AiProviderKind = 'openai' | 'anthropic' | 'gemini' | 'ollama'

export interface AiProviderInfo {
  id: string
  name: string
  kind: AiProviderKind
  baseUrl: string
  model: string
  temperature: number
  hasKey: boolean
}

export interface AiProviderInput {
  id?: string
  name: string
  kind: AiProviderKind
  baseUrl: string
  model: string
  apiKey?: string
  temperature?: number
}

/** A tool invocation requested by the model, in the shape MCP servers use. */
export interface AiToolCall {
  id: string
  name: string
  /** Raw JSON string exactly as the model produced it. */
  arguments: string
}

/** Result returned to the model for one tool call. */
export interface AiToolResult {
  ok: boolean
  content: string
}

export type AiRole = 'system' | 'user' | 'assistant' | 'tool'

export interface AiMessage {
  id: string
  role: AiRole
  content: string
  createdAt: string
  /** Assistant turns that asked for tools. */
  toolCalls?: AiToolCall[]
  /** Tool result turns. */
  toolCallId?: string
  name?: string
  /** Tool result failed. */
  error?: boolean
}

export interface AiConversationInfo {
  id: string
  title: string
  providerId: string
  messages: AiMessage[]
  createdAt: string
  updatedAt: string
}

export interface AiChatInput {
  providerId: string
  conversationId?: string
  /** Only the new turn; the conversation already holds the earlier ones. */
  message?: string
  /** Re-run the last user turn instead of appending a new one. */
  regenerate?: boolean
  /** Extra context appended to the system prompt (current Canvas, params…). */
  context?: string
}

export interface AiChatResult {
  reply: string
  conversation: AiConversationInfo
}

/** MCP-style tool description: name/description/inputSchema. */
export interface AiToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Events streamed to the renderer while a chat turn is running. */
export type AiStreamEvent =
  | { type: 'start'; conversationId: string; messageId: string }
  | { type: 'delta'; conversationId: string; messageId: string; text: string }
  | { type: 'tool'; conversationId: string; call: AiToolCall }
  | { type: 'tool-result'; conversationId: string; callId: string; result: AiToolResult }
  | { type: 'done'; conversationId: string; conversation: AiConversationInfo }
  | { type: 'error'; conversationId: string; message: string }

/** Sent from main to the renderer when a tool must run against Studio state. */
export interface AiToolCallRequest {
  callId: string
  name: string
  arguments: string
}

export const AI_PROVIDER_PRESETS: Array<{
  kind: AiProviderKind
  name: string
  baseUrl: string
  model: string
}> = [
  { kind: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  { kind: 'openai', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { kind: 'openai', name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { kind: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  { kind: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
  { kind: 'ollama', name: 'Ollama (local)', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.1' },
]
