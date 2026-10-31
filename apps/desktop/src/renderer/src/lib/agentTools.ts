import type { AiToolCall, AiToolResult } from '@shared/ai'
import { Events, Ipc } from '@shared/channels'
import { call, onEvent } from './api'

/**
 * The renderer owns the Studio state, so tool calls are executed here and the
 * result is handed back to the main process, which relays it to the model.
 */
export interface StudioToolApi {
  readContext(): unknown
  setPrompt(prompt: string): unknown
  setSampler(patch: { width?: number; height?: number; steps?: number; cfg?: number; seed?: number }): unknown
  addLayer(input: {
    label: 'object' | 'character' | 'text'
    caption: string
    bbox?: { x: number; y: number; w: number; h: number }
  }): unknown
  generate(prompt?: string): Promise<unknown> | unknown
}

let api: StudioToolApi | null = null

export function registerStudioTools(next: StudioToolApi | null): void {
  api = next
}

function ok(payload: unknown): AiToolResult {
  return { ok: true, content: JSON.stringify(payload) }
}

function fail(message: string): AiToolResult {
  return { ok: false, content: JSON.stringify({ error: message }) }
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export async function executeStudioTool(call_: AiToolCall): Promise<AiToolResult> {
  if (!api) return fail('Studio 尚未就绪，请先在创作页打开一个项目')
  const args = parseArguments(call_.arguments)
  try {
    switch (call_.name) {
      case 'studio_read_context':
        return ok(api.readContext())
      case 'studio_set_prompt': {
        const prompt = typeof args.prompt === 'string' ? args.prompt : ''
        if (!prompt.trim()) return fail('prompt 不能为空')
        api.setPrompt(prompt)
        return ok({ written: prompt.length })
      }
      case 'studio_set_sampler': {
        const patch = {
          width: asNumber(args.width),
          height: asNumber(args.height),
          steps: asNumber(args.steps),
          cfg: asNumber(args.cfg),
          seed: asNumber(args.seed),
        }
        if (Object.values(patch).every((value) => value === undefined)) return fail('没有可更新的字段')
        return ok(api.setSampler(patch))
      }
      case 'studio_add_layer': {
        const label = args.label === 'character' || args.label === 'text' || args.label === 'object' ? args.label : null
        if (!label) return fail('label 必须是 object / character / text')
        const caption = typeof args.caption === 'string' ? args.caption.trim() : ''
        if (!caption) return fail('caption 不能为空')
        const raw = args.bbox as { x?: number; y?: number; w?: number; h?: number } | undefined
        const bbox = raw && ['x', 'y', 'w', 'h'].every((key) => typeof raw[key as keyof typeof raw] === 'number')
          ? { x: raw.x as number, y: raw.y as number, w: raw.w as number, h: raw.h as number }
          : undefined
        return ok(api.addLayer({ label, caption, bbox }))
      }
      case 'studio_generate': {
        const prompt = typeof args.prompt === 'string' ? args.prompt : undefined
        const result = await api.generate(prompt)
        return ok(result ?? { queued: true })
      }
      default:
        return fail(`未知工具 ${call_.name}`)
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

/** Subscribe once; resolves every tool call the main process asks for. */
export function installStudioToolBridge(): () => void {
  return onEvent<{ callId: string; name: string; arguments: string }>(Events.aiToolCall, (request) => {
    void (async () => {
      const result = await executeStudioTool({ id: request.callId, name: request.name, arguments: request.arguments })
      await call(Ipc.aiToolResult, { callId: request.callId, result }).catch(() => undefined)
    })()
  })
}
