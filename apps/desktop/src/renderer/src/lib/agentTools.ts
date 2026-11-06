import type { AiToolCall, AiToolResult } from '@shared/ai'
import { Events, Ipc } from '@shared/channels'
import { call, onEvent } from './api'

/** What the assistant sees of the canvas the user is working on. */
export interface StudioSnapshot {
  title: string
  description: string
  width: number
  height: number
  regions: Array<{ kind: 'object' | 'character' | 'text'; caption: string; text?: string; visible: boolean }>
}

/**
 * The renderer owns the Studio state, so tool calls are executed here and the
 * result is handed back to the main process, which relays it to the model.
 * Every method must read the Studio's live state at call time, never a value
 * captured when the API was registered.
 */
export interface StudioToolApi {
  readContext(): unknown
  /** Plain snapshot of the selected canvas, or null when none is selected. */
  snapshot(): StudioSnapshot | null
  /** Replace the description of the selected canvas; throws when it cannot be edited. */
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

/** The selected canvas as it is right now (not when a chat message was typed). */
export function readStudioSnapshot(): StudioSnapshot | null {
  return api?.snapshot() ?? null
}

/** Write a description into the selected canvas; false when the Studio is not ready. */
export function applyStudioDescription(text: string): boolean {
  if (!api || !api.snapshot()) return false
  try {
    api.setPrompt(text)
    return true
  } catch {
    // The selected canvas is a finished result and cannot be edited.
    return false
  }
}

/** Context block appended to the assistant's system prompt on every turn. */
export function formatStudioContext(snapshot: StudioSnapshot | null): string | undefined {
  if (!snapshot) return undefined
  const lines = [
    `The user is working on the Studio canvas "${snapshot.title}" (${snapshot.width}×${snapshot.height}).`,
    snapshot.description.trim() ? `Its description currently reads:\n${snapshot.description.trim()}` : 'Its description is empty.',
  ]
  if (snapshot.regions.length) {
    lines.push('Its regions, in order:')
    snapshot.regions.forEach((region, index) => {
      const text = region.kind === 'text' && region.text ? ` [text: ${region.text}]` : ''
      const hidden = region.visible ? '' : ' (hidden)'
      lines.push(`${index + 1}. ${region.kind}: ${region.caption.trim() || '(no caption)'}${text}${hidden}`)
    })
  } else {
    lines.push('It has no regions.')
  }
  return lines.join('\n')
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
        const bbox =
          raw && ['x', 'y', 'w', 'h'].every((key) => typeof raw[key as keyof typeof raw] === 'number')
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
