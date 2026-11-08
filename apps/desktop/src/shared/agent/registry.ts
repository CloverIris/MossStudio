import { z } from 'zod'
import type { AgentMode, AiToolDefinition } from '../ai'
import { TOOL_SCHEMAS, type ToolName } from './schemas'

export type { AgentMode }

/**
 * The tool rack: one entry per tool, and the only place that says what a tool
 * is called, which pack it belongs to, how risky it is and how to summarise it
 * in the chat. The provider's JSON Schema is generated from the zod schema of
 * the same name, and the renderer's handler table is typed from it, so the
 * three can no longer drift apart.
 */

export type AgentPack = 'canvas.read' | 'canvas.write' | 'ask' | 'storyboard' | 'library'

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
    name: 'studio_select_canvas',
    title: '切换画面',
    pack: 'canvas.read',
    risk: 'read',
    requires: [],
    description:
      'Make another Canvas of the project the selected one. Every tool that edits "the selected Canvas" works on it afterwards. Only the selection changes, never the picture.',
    summarize: (args) => `切到 ${short(text(args.id), 16)}`,
  },
  {
    name: 'studio_ask_user',
    title: '问你一句',
    pack: 'ask',
    risk: 'ask',
    requires: [],
    description:
      'Ask the user one question and show it as a card with 2-5 choices (single or multiple). Use it when the answer decides the picture and you cannot read it from the canvas: composition, character details, sizes, wording. After calling it, stop your turn: the user answers on the card and the next turn continues.',
    summarize: (args) => `问：${short(text(args.question), 24)}`,
  },
  {
    name: 'studio_ask_approval',
    title: '等你确认',
    pack: 'ask',
    risk: 'ask',
    requires: [],
    description:
      'Ask the user to approve or reject one concrete next step: starting a generation, a batch of pictures, anything that spends GPU time or cannot be undone. Shows a card with approve, reject and "change it" buttons. Use it instead of asking "要开始吗" in prose. After calling it, stop your turn.',
    summarize: (args) => `等你确认：${short(text(args.question), 22)}`,
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
  {
    name: 'studio_create_scenes',
    title: '建一套画面',
    pack: 'storyboard',
    risk: 'write',
    requires: [],
    description:
      'Build a set of layout Canvases in one go, one per scene, each with its description, regions and words. Use it when the user wants a series, a storyboard or several pictures at once: plan every scene first, then call this once. The result lists the new ids; select one with studio_select_canvas to refine it.',
    summarize: (args) => {
      const scenes = Array.isArray(args.scenes) ? (args.scenes as Array<{ title?: unknown }>) : []
      const titles = scenes.map((scene) => text(scene?.title)).filter(Boolean)
      return titles.length ? `新建 ${scenes.length} 个画面：${short(titles.slice(0, 3).join('、'), 48)}` : `新建 ${scenes.length} 个画面`
    },
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
 * Which packs are mounted right now. Both modes mount the same canvas and ask
 * tools; the mode changes how a write is applied (at once, or through a plan
 * card the user confirms), not what the model can see. The storyboard pack
 * lands in P4 and mounts on the Studio only.
 */
export function resolveToolset(input: ToolsetInput = {}): AgentTool[] {
  if (input.toolsSupported === false) return []
  const page = input.page ?? 'studio'
  return AGENT_TOOLS.filter((tool) => {
    if (tool.pack === 'canvas.read' || tool.pack === 'ask') return true
    if (tool.pack === 'canvas.write' || tool.pack === 'storyboard') return page === 'studio'
    return false
  })
}

/** Rules about the tools themselves, kept next to their definitions. */
export const TOOL_RULES = `How to work:
- Read studio_read_context before changing anything you have not just seen.
- Words in the picture go through studio_add_text_layer: caption describes the lettering (style, weight, colour, placement), text holds exactly the characters to render. Never put the words in caption, and never leave text empty.
- Objects and characters go through studio_add_layer.
- Fix a region with studio_update_layer, addressed by its 1-based index from studio_read_context, instead of adding another one; delete it with studio_remove_layer.
- Ask with studio_ask_user when the picture depends on a choice only the user can make: composition, how a character looks, the exact wording, a size. One question, two to five concrete options. After asking, stop and say in one line what you are waiting for; the answer arrives as the next message.
- Before starting a generation the user did not just ask for, or any step that spends GPU time on several pictures, ask with studio_ask_approval: approve, reject, or change it. Never start a batch on your own.
- A set of pictures (a series, a storyboard, "一套图") goes through studio_create_scenes: plan every scene, then build them in one call. Use studio_select_canvas to move between the new canvases and refine the ones that need it.
- Every write result ends with problems: what still blocks generation. Clear them before calling studio_generate.
- studio_generate returns immediately with a job id; call it once per request and do not wait for the picture.
- Report the sampler values that were actually used, never values you made up.`

/** How the two modes differ, appended to the base prompt on every turn. */
export const MODE_RULES: Record<AgentMode, string> = {
  auto: `The user picked 自动模式. Make the changes yourself and describe them in one or two sentences. Only ask when the answer really decides the picture and you cannot pick a sensible default.`,
  advanced: `The user picked 高级模式. Every studio_* tool that changes the canvas is shown to them as a plan card and only applied when they confirm it, so:
- Put related edits in one turn, so the user confirms one plan instead of five.
- Make the plan concrete: exact captions, exact words, exact sizes. Say what will change in one sentence.
- If they asked for several pictures or a set, plan all of them before applying anything.
- Ask with studio_ask_user when a choice would change the result; do not guess on their behalf.`,
}
