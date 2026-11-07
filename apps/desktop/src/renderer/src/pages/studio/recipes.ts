import type { ControlAdapterEntry, EngineFeatures } from '@shared/types'
import type { LinkRole } from './links'
import { engineUnavailableReason, type Blocker } from './readiness'

/**
 * Recipes: common ways to start, each laying out a 画面 already wired to a
 * picture the user chooses. A recipe is only a starting layout; nothing about
 * it is special afterwards. Pure, no React.
 */

export type RecipeId = 'edit' | 'inpaint' | 'compose' | 'style'

export interface Recipe {
  id: RecipeId
  label: string
  /** What it does, for the tooltip. */
  hint: string
  /** How the chosen picture feeds the new 画面. */
  role: LinkRole
  /** Why it cannot be used now; absent when it can. */
  disabled?: string
}

const RECIPES: readonly Omit<Recipe, 'disabled'>[] = [
  { id: 'edit', label: '改一张图', hint: '选一张图，从它开始改', role: 'init' },
  { id: 'inpaint', label: '局部重绘', hint: '选一张图，只重画涂出来的部分', role: 'init' },
  { id: 'compose', label: '按构图生成', hint: '选一张图，按它的深度或轮廓构图', role: 'control' },
  { id: 'style', label: '参考风格', hint: '选一张图，让结果参考它', role: 'reference' },
]

const FLAG: Record<LinkRole, 'imageInput' | 'control' | 'references'> = {
  init: 'imageInput',
  control: 'control',
  reference: 'references',
}

/**
 * The recipes, each with why it is off when it is. `features` undefined
 * means still reading (offered); null means no engine is usable.
 */
export function recipes(
  features: EngineFeatures | null | undefined,
  adapters: readonly ControlAdapterEntry[],
  blockers: readonly Blocker[] = [],
): Recipe[] {
  const engine = features === null ? engineUnavailableReason(features, blockers, '使用') : null
  return RECIPES.map((recipe) => {
    if (engine) return { ...recipe, disabled: engine }
    if (features && !features[FLAG[recipe.role]]) return { ...recipe, disabled: '现在的引擎不支持这个做法' }
    if (recipe.role === 'control' && !adapters.some((adapter) => adapter.controlKinds.length)) {
      return { ...recipe, disabled: '需要先在模型页添加控制适配器' }
    }
    return { ...recipe }
  })
}
