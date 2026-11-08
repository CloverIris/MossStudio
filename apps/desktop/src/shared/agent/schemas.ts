import { z } from 'zod'

/**
 * The arguments of every tool the Agent can call, as zod schemas.
 *
 * This is the only place a tool's parameters are written down: the JSON Schema
 * sent to the provider is generated from here, and the renderer parses the
 * model's arguments with the same schema. A field that exists here exists
 * everywhere; a field the executor needs cannot be missing from here.
 */

/** Normalised box: origin and size, 0-1 of the canvas width and height. */
const box = z
  .strictObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0.02).max(1),
    h: z.number().min(0.02).max(1),
  })
  .describe('Normalised box: x and y are the top-left corner, w and h the size, all 0-1 of the canvas.')

export const TOOL_SCHEMAS = {
  studio_read_context: z.strictObject({}),

  studio_set_prompt: z.strictObject({
    prompt: z.string().trim().min(1).max(4000).describe('The full description to write.'),
  }),

  studio_set_sampler: z.strictObject({
    width: z.number().int().min(256).max(2048).optional().describe('Image width in pixels, a multiple of 16.'),
    height: z.number().int().min(256).max(2048).optional().describe('Image height in pixels, a multiple of 16.'),
    steps: z.number().int().min(1).max(100).optional().describe('Denoise steps. 8 for DMD profiles, 20-50 otherwise.'),
    cfg: z.number().min(0).max(20).optional().describe('Classifier-free guidance scale.'),
    seed: z.number().int().min(0).optional().describe('Random seed.'),
  }),

  studio_add_layer: z.strictObject({
    label: z.enum(['object', 'character']).describe('Region kind. Words in the picture use studio_add_text_layer.'),
    caption: z.string().trim().min(1).max(600).describe('Short English description of what belongs inside the region.'),
    bbox: box.optional().describe('Where the region sits. Omit to stack it on top of the existing regions.'),
  }),

  studio_add_text_layer: z.strictObject({
    caption: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .describe(
        'English description of the lettering itself: style, weight, colour and where it sits, for example "large gold serif title along the top edge". Never put the words here.',
      ),
    text: z
      .string()
      .trim()
      .min(1)
      .max(400)
      .describe('The exact characters to render, in the user\'s language, without surrounding quotes and without a "reading" prefix.'),
    bbox: box.optional().describe('Where the words sit. Omit to stack the region on top of the existing ones.'),
  }),

  studio_update_layer: z.strictObject({
    index: z.number().int().min(1).describe('1-based region index, as listed by studio_read_context.'),
    caption: z.string().trim().min(1).max(600).optional().describe('New English description of the region.'),
    text: z
      .string()
      .trim()
      .max(400)
      .optional()
      .describe('New characters to render on a text region. An empty string clears them, which blocks generation.'),
    bbox: box.optional().describe('New position and size.'),
    visible: z.boolean().optional().describe('False hides the region from generation.'),
    opacity: z.number().min(0.1).max(1).optional().describe('Region opacity, 0.1-1.'),
  }),

  studio_remove_layer: z.strictObject({
    index: z.number().int().min(1).describe('1-based region index, as listed by studio_read_context.'),
  }),

  studio_generate: z.strictObject({
    prompt: z.string().min(1).max(4000).optional().describe('Optional description to write before generating.'),
  }),
} as const

export type ToolName = keyof typeof TOOL_SCHEMAS
export type ToolArgs<N extends ToolName> = z.infer<(typeof TOOL_SCHEMAS)[N]>
