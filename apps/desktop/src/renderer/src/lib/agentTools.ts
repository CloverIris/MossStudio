import { Events, Ipc } from '@shared/channels'
import type { AgentMode } from '@shared/ai'
import { call, onEvent } from './api'
import { applyPlan, executeStudioTool, getStudioApi, setStudioApi } from './agent/executor'
import type { StudioSnapshot, StudioToolApi } from './agent/types'

export type { AddedLayer, LayerBox, LayerPatch, StudioSnapshot, StudioToolApi } from './agent/types'
export { applyPlan, executeStudioTool }

export function registerStudioTools(next: StudioToolApi | null): void {
  setStudioApi(next)
}

/** The selected canvas as it is right now (not when a chat message was typed). */
export function readStudioSnapshot(): StudioSnapshot | null {
  return getStudioApi()?.snapshot() ?? null
}

/** Write a description into the selected canvas; false when the Studio is not ready. */
export function applyStudioDescription(text: string): boolean {
  const api = getStudioApi()
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

/** Subscribe once; resolves every tool call the main process asks for. */
export function installStudioToolBridge(): () => void {
  return onEvent<{ callId: string; name: string; arguments: string; mode?: AgentMode }>(Events.aiToolCall, (request) => {
    void (async () => {
      const result = await executeStudioTool(
        { id: request.callId, name: request.name, arguments: request.arguments },
        { mode: request.mode },
      )
      await call(Ipc.aiToolResult, { callId: request.callId, result }).catch(() => undefined)
    })()
  })
}
