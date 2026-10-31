import type { AiToolDefinition } from './ai'

/**
 * Tools exposed to the Agent, described the way an MCP server describes them:
 * a stable snake_case name, a natural-language description and a JSON Schema
 * for the arguments. The renderer executes them against the live Studio state,
 * so the model can drive the workbench instead of only returning text.
 */
export const STUDIO_TOOLS: AiToolDefinition[] = [
  {
    name: 'studio_read_context',
    description:
      'Read the current MossStudio workbench state: selected Canvas, its size, sampler values, prompt, layout regions and the list of Canvases in the project. Call this before changing anything.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'studio_set_prompt',
    description:
      'Replace the prompt of the selected layout Canvas. Use plain English prose. This writes immediately and is visible to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The full prompt text to write.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'studio_set_sampler',
    description:
      'Update sampler values on the selected layout Canvas. Only pass the fields you want to change.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'integer', minimum: 256, maximum: 2048, description: 'Image width in pixels, multiple of 16.' },
        height: { type: 'integer', minimum: 256, maximum: 2048, description: 'Image height in pixels, multiple of 16.' },
        steps: { type: 'integer', minimum: 1, maximum: 100, description: 'Denoise steps. 8 for DMD profiles, 20-50 otherwise.' },
        cfg: { type: 'number', minimum: 0, maximum: 20, description: 'Classifier-free guidance scale.' },
        seed: { type: 'integer', description: 'Random seed.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'studio_add_layer',
    description:
      'Add one layout region (bounding box) to the selected Canvas. Regions are what MOSS-Image uses for layout control; each region carries its own caption.',
    inputSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          enum: ['object', 'character', 'text'],
          description: 'Region kind: object, character or text.',
        },
        caption: { type: 'string', description: 'Short English description of what belongs inside this region.' },
        bbox: {
          type: 'object',
          description: 'Normalised box, 0-1 relative to the Canvas. Omit to stack the region on top of existing ones.',
          properties: {
            x: { type: 'number', minimum: 0, maximum: 1 },
            y: { type: 'number', minimum: 0, maximum: 1 },
            w: { type: 'number', minimum: 0.02, maximum: 1 },
            h: { type: 'number', minimum: 0.02, maximum: 1 },
          },
          required: ['x', 'y', 'w', 'h'],
          additionalProperties: false,
        },
      },
      required: ['label', 'caption'],
      additionalProperties: false,
    },
  },
  {
    name: 'studio_generate',
    description:
      'Start generating with the selected layout Canvas and the parameters currently on it. Returns immediately with a job id; progress shows on the Canvas. Optionally write a new prompt first.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Optional prompt to write before generating.' },
      },
      additionalProperties: false,
    },
  },
]

export const STUDIO_TOOL_NAMES = new Set(STUDIO_TOOLS.map((tool) => tool.name))
