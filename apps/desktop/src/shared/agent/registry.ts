import { z } from 'zod'
import type { AiToolDefinition } from '../ai'
import { TOOL_SCHEMAS, type ToolName } from './schemas'

/**
 * The tool rack: one entry per tool, and the only place that says what a tool
 * is called, which pack it belongs to, how risky it is and how to summarise it
 * in the chat. The provider's JSON Schema is generated from the zod schema of
 * the same name, and the renderer's handler table is typed from it, so the
 * three can no longer drift apart.
 */

export type AgentPack = 'canvas.read' | 'canvas.write' | 'ask' | 'storyboard' | 'library'

export type AgentMode = 'auto' | 'advanced'

/** read: only looks. write: changes the canvas. run: starts a job. ask: asks the user. */
export type ToolRisk = 'read' | 'write' | 'run' | 'ask'

/** What must be true before a tool can run; checked once, in the executor. */
export type ToolRequirement = 'selection' | 'editable' | 'engine'

export interface AgentTool {
  name: ToolName
  /** Short Chinese name, used on the tool line in the chat. */
  title: string
  pack: AgentPack
  /** English, for the model: what it does and when not to use it. */
  description: string
  risk: ToolRisk
  requires: readonly ToolRequirement[]
  /** One line for the chat, built from the arguments rather than from a JSON dump. */
  summarize(args: Record<string, unknown>): string
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function short(value: string, limit = 20): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'studio_read_context',
    title: '查看画面',
    pack: 'canvas.read',
    risk: 'read',
    requires: [],
    description:
      'Read the workbench: the selected Canvas (size, sampler values, description) and every region with its 1-based index, kind, caption, text and box. Call it before changing anything you have not just seen.',
    summarize: () => '当前画面',
  },
  {
    name: 'studio_set_prompt',
    title: '改写描述',
    pack: 'canvas.write',
    risk: 'write',
    requires: ['editable'],
    description:
      'Replace the description of the selected Canvas. Plain English prose, one paragraph. Writes immediately and is visible to the user.',
    summarize: (args) => `描述改为「${short(text(args.prompt))}」`,
  },
  {
    name: 'studio_set_sampler',
    title: '调整参数',
    pack: 'canvas.write',
    risk: 'write',
    requires: ['editable'],
    description:
      'Update sampler values on the selected Canvas. Pass only the fields you want to change; the result reports the values actually used, which may be snapped to a preset.',
    summarize: (args) => {
      const size =
        number(args.width) !== undefined || number(args.height) !== undefined
          ? `${number(args.width) ?? '?'}×${number(args.height) ?? '?'}`
          : ''
      const steps = number(args.steps) !== undefined ? `${number(args.steps)} 步` : ''
      const cfg = number(args.cfg) !== undefined ? `CFG ${number(args.cfg)}` : ''
      const seed = number(args.seed) !== undefined ? `种子 ${number(args.seed)}` : ''
      const parts = [size, steps, cfg, seed].filter(Boolean)
      return parts.length ? `参数 ${parts.join(' · ')}` : '参数'
    },
  },
  {
    name: 'studio_add_layer',
    title: '添加区域',
    pack: 'canvas.write',
    risk: 'write',
    requires: ['editable'],
    description:
      'Add one object or character region to the selected Canvas. Words in the picture are not regions of this kind: use studio_add_text_layer. Regions are what MOSS-Image uses for layout control.',
    summarize: (args) => `${args.label === 'character' ? '人物' : '物体'}「${short(text(args.caption))}」`,
  },
  {
    name: 'studio_add_text_layer',
    title: '添加文字',
    pack: 'canvas.write',
    risk: 'write',
    requires: ['editable'],
    description:
      'Add one text region: caption says how the lettering looks and where it sits, text is exactly what should be rendered. Use this for titles, signs, labels and any other words in the picture, and only after you know the exact words.',
    summarize: (args) => `文字「${short(text(args.text))}」`,
  },
  {
    name: 'studio_update_layer',
    title: '修改区域',
    pack: 'canvas.write',
    risk: 'write',
    requires: ['editable'],
    description:
      'Change one region of the selected Canvas by its 1-based index from studio_read_context. Use it to fix or refine a region instead of adding a second one.',
    summarize: (args) => `第 ${number(args.index) ?? '?'} 个区域`,
  },
  {
    name: 'studio_remove_layer',
    title: '删除区域',
    pack: 'canvas.write',
    risk: 'write',
    requires: ['editable'],
    description: 'Delete one region of the selected Canvas by its 1-based index from studio_read_context.',
    summarize: (args) => `第 ${number(args.index) ?? '?'} 个区域`,
  },
  {
    name: 'studio_generate',
    title: '开始生成',
    pack: 'canvas.write',
    risk: 'run',
    requires: ['editable'],
    description:
      'Start generating from the selected Canvas exactly as it is now. Returns immediately with a job id; call it once per request and do not wait for the picture. Generation fails while the Canvas still has problems.',
    summarize: () => '按当前画面生成',
  },
]

export const AGENT_TOOL_NAMES: readonly ToolName[] = AGENT_TOOLS.map((tool) => tool.name)

export function toolByName(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name)
}

/** JSON Schema for one tool, without the `$schema` key some providers reject. */
export function toolSchema(name: ToolName): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(TOOL_SCHEMAS[name]) as Record<string, unknown>
  return schema
}

/** The tool list a provider receives. */
export function toolDefinitions(tools: readonly AgentTool[] = AGENT_TOOLS): AiToolDefinition[] {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: toolSchema(tool.name) }))
}

export interface ToolsetInput {
  mode?: AgentMode
  /** Which screen the assistant sits on; only the Studio can change a Canvas today. */
  page?: 'studio' | 'library' | 'models' | 'training'
  /** False for providers that cannot call tools at all (the local Ollama path). */
  toolsSupported?: boolean
}

/**
 * Which packs are mounted right now. Auto and advanced mount the same canvas
 * tools; the mode changes how they are applied (see the design doc), not what
 * the model can see. Ask, storyboard and library packs join in later phases.
 */
export function resolveToolset(input: ToolsetInput = {}): AgentTool[] {
  if (input.toolsSupported === false) return []
  const page = input.page ?? 'studio'
  return AGENT_TOOLS.filter((tool) => {
    if (tool.pack === 'canvas.read') return true
    if (tool.pack === 'canvas.write') return page === 'studio'
    return false
  })
}

/** Rules about the tools themselves, kept next to their definitions. */
export const TOOL_RULES = `How to work:
- Read studio_read_context before changing anything you have not just seen.
- Words in the picture go through studio_add_text_layer: caption describes the lettering (style, weight, colour, placement), text holds exactly the characters to render. Never put the words in caption, and never leave text empty.
- Objects and characters go through studio_add_layer.
- Fix a region with studio_update_layer, addressed by its 1-based index from studio_read_context, instead of adding another one; delete it with studio_remove_layer.
- Every write result ends with problems: what still blocks generation. Clear them before calling studio_generate.
- studio_generate returns immediately with a job id; call it once per request and do not wait for the picture.
- Report the sampler values that were actually used, never values you made up.`
