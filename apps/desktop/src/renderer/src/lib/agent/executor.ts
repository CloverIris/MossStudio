import type { ZodError } from 'zod'
import type { AiToolCall, AiToolResult } from '@shared/ai'
import { toolByName, type AgentTool } from '@shared/agent/registry'
import { TOOL_SCHEMAS, type ToolArgs, type ToolName } from '@shared/agent/schemas'
import type { StudioToolApi } from './types'

/**
 * Runs the tools the model asks for against the live Studio state.
 *
 * Arguments are parsed with the same zod schema their JSON Schema was generated
 * from, so a field the model forgets is reported here instead of producing a
 * half-built region. The handler table is exhaustive over `ToolName`: adding a
 * tool without a handler is a type error, not a runtime "未知工具".
 */

let live: StudioToolApi | null = null

export function setStudioApi(next: StudioToolApi | null): void {
  live = next
}

export function getStudioApi(): StudioToolApi | null {
  return live
}

/** A tool refusing to run for a reason the model can act on. */
class ToolFailure extends Error {
  constructor(
    message: string,
    readonly fix?: { tool: ToolName; args?: Record<string, unknown> },
  ) {
    super(message)
  }
}

type Handler<N extends ToolName> = (args: ToolArgs<N>, api: StudioToolApi) => unknown | Promise<unknown>

const HANDLERS: { [N in ToolName]: Handler<N> } = {
  studio_read_context: (_args, api) => api.readContext(),

  studio_set_prompt: ({ prompt }, api) => api.setPrompt(prompt),

  studio_set_sampler: (args, api) => {
    if (Object.values(args).every((value) => value === undefined)) throw new ToolFailure('没有可更新的字段')
    return api.setSampler(args)
  },

  studio_add_layer: ({ label, caption, bbox }, api) => api.addLayer({ label, caption, bbox }),

  studio_add_text_layer: ({ caption, text, bbox }, api) => api.addTextLayer({ caption, text, bbox }),

  studio_update_layer: ({ index, ...patch }, api) => api.updateLayer({ index, patch }),

  studio_remove_layer: ({ index }, api) => api.removeLayer(index),

  studio_generate: async ({ prompt }, api) => (await api.generate(prompt)) ?? { queued: true },
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const ISSUE_REASONS: Record<string, string> = {
  invalid_type: '类型不对',
  too_small: '太短或太小',
  too_big: '太长或太大',
  invalid_value: '取值不对',
  unrecognized_keys: '多了不认识的字段',
}

/** A schema failure in words the model (and the tool line) can act on. */
function explainIssues(error: ZodError): string {
  const issue = error.issues[0]
  if (!issue) return '参数不对'
  const path = issue.path.join('.')
  const reason = ISSUE_REASONS[issue.code] ?? issue.message
  return path ? `参数不对：${path} ${reason}` : `参数不对：${reason}`
}

function ok(data: unknown, extra?: Record<string, unknown>): AiToolResult {
  const body =
    data && typeof data === 'object' && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), ...extra }
      : { value: data, ...extra }
  return { ok: true, content: JSON.stringify(body) }
}

function fail(error: string, fix?: { tool: ToolName; args?: Record<string, unknown> }): AiToolResult {
  return { ok: false, content: JSON.stringify(fix ? { error, fix } : { error }) }
}

/** Region handles used to be a single tool; send those calls to the right one. */
function replacedTool(name: string, raw: Record<string, unknown>): AiToolResult | null {
  if (name !== 'studio_add_layer' || raw.label !== 'text') return null
  return fail('文字区域请用 studio_add_text_layer：caption 写样式，text 写要显示的文字', { tool: 'studio_add_text_layer' })
}

/** The two failures every editing tool shares, reported the same way. */
function precheck(tool: AgentTool, api: StudioToolApi): AiToolResult | null {
  if (!tool.requires.includes('editable')) return null
  const state = api.state()
  if (!state.hasSelection) return fail('先在画布上选中一个画面')
  if (!state.editable) return fail('选中的是生成结果，不能修改；请先复制成新画面')
  return null
}

function problemsOf(api: StudioToolApi): string[] {
  try {
    return api.problems()
  } catch {
    return []
  }
}

async function dispatch<N extends ToolName>(name: N, raw: Record<string, unknown>, api: StudioToolApi): Promise<AiToolResult> {
  const parsed = TOOL_SCHEMAS[name].safeParse(raw)
  if (!parsed.success) return fail(explainIssues(parsed.error))
  const tool = toolByName(name)
  // The schema and the handler are looked up by the same name, so the parsed
  // value is this tool's own argument type; TypeScript only sees the union.
  const args = parsed.data as ToolArgs<N>
  const data = await HANDLERS[name](args, api)
  if (!tool || tool.risk === 'read') return ok(data)
  // Writes and runs report what the canvas still lacks, so the model does not
  // have to call studio_generate just to discover a region is incomplete.
  return ok(data, { summary: tool.summarize(args), problems: problemsOf(api) })
}

export async function executeStudioTool(call: AiToolCall): Promise<AiToolResult> {
  const tool = toolByName(call.name)
  if (!tool) return fail(`未知工具 ${call.name}`)
  const api = live
  if (!api) return fail('Studio 尚未就绪，请先在创作页打开一个项目')
  const raw = parseArguments(call.arguments)
  const replaced = replacedTool(call.name, raw)
  if (replaced) return replaced
  try {
    const blocked = precheck(tool, api)
    if (blocked) return blocked
    return await dispatch(tool.name, raw, api)
  } catch (error) {
    if (error instanceof ToolFailure) return fail(error.message, error.fix)
    return fail(error instanceof Error ? error.message : String(error))
  }
}
