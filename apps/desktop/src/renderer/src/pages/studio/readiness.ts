import type { AdapterEntry, Catalog, EngineReadiness, ModelBundle, ModelEntry, ProjectCanvas } from '@shared/types'
import { adapterStatuses, normalizeCanvasAdapters } from '@shared/adapters'
import { compileCanvasPrompt, type CompiledPrompt } from './prompt'

/** Problems with a canvas's pictures and sampling choices (see jobInputs.ts). */
export type InputBlockerId = 'input-source' | 'input-adapter' | 'input-unsupported' | 'input-invalid'

/**
 * What stands between the user and the 生成 button. Only real blockers are
 * listed; each one says what is wrong and, when the fix lives elsewhere, where
 * to go. Pure so every combination is unit tested.
 */

export interface Blocker {
  id: 'model-none' | 'model-missing' | 'engine' | 'remote-path' | 'adapters' | 'remote-adapters' | 'prompt' | InputBlockerId
  message: string
  action?: { label: string; to: string }
}

/** A bundle is usable when every file it needs is installed. */
export function bundleInstalled(bundle: ModelBundle, models: readonly ModelEntry[]): boolean {
  const ids = [bundle.components.dit, bundle.components.textEncoder, bundle.components.vae, bundle.support].filter(Boolean)
  return ids.every((id) => models.some((model) => model.id === id && model.installed))
}

export function installedBundles(catalog: Pick<Catalog, 'bundles' | 'models'> | null | undefined): ModelBundle[] {
  if (!catalog) return []
  return catalog.bundles.filter((bundle) => bundleInstalled(bundle, catalog.models))
}

export interface BundleChoice {
  /** The bundle this canvas runs with, if one can be resolved. */
  bundle: ModelBundle | null
  installed: boolean
  /** The canvas names a bundle the catalog no longer has. */
  unavailable: boolean
}

/**
 * The model a canvas runs with: the one it names, otherwise the user's last
 * pick, otherwise the recommended installed one, otherwise the first installed.
 */
export function resolveBundle(
  catalog: Pick<Catalog, 'bundles' | 'models'> | null | undefined,
  requestedId: string | undefined,
  preferredId?: string | null,
): BundleChoice {
  if (!catalog) return { bundle: null, installed: false, unavailable: false }
  if (requestedId) {
    const bundle = catalog.bundles.find((item) => item.id === requestedId) ?? null
    if (!bundle) return { bundle: null, installed: false, unavailable: true }
    return { bundle, installed: bundleInstalled(bundle, catalog.models), unavailable: false }
  }
  const installed = installedBundles(catalog)
  const bundle = installed.find((item) => item.id === preferredId)
    ?? installed.find((item) => item.recommended)
    ?? installed[0]
    ?? null
  return { bundle, installed: Boolean(bundle), unavailable: false }
}

export interface ReadinessInput {
  canvas: Pick<ProjectCanvas, 'prompt' | 'summary' | 'layers' | 'width' | 'height' | 'adapters'> | null
  catalog: Pick<Catalog, 'bundles' | 'models'> & { adapters?: readonly AdapterEntry[] } | null | undefined
  bundle: BundleChoice
  /** Local engine state; null while it is still being read (never a blocker then). */
  engine: EngineReadiness | null
  /** True once first-run setup has been completed or dismissed. */
  setupDone: boolean
  /** The SSH machine this run goes to, when remote hosts are enabled and one is picked. */
  remote: { name: string; modelPath?: string } | null
  /** What is wrong with the canvas's pictures and sampling (from `resolveJobInputs`). */
  inputBlockers?: readonly Blocker[]
}

export interface Readiness {
  blockers: Blocker[]
  prompt: CompiledPrompt | null
}

export function deriveReadiness(input: ReadinessInput): Readiness {
  const blockers: Blocker[] = []
  const toModels = { label: '去下载', to: '/models' }
  if (input.catalog) {
    if (input.bundle.unavailable) {
      blockers.push({ id: 'model-missing', message: '这个画面用的模型已经不在模型库里，请换一个模型', action: installedBundles(input.catalog).length ? undefined : toModels })
    } else if (!input.bundle.bundle) {
      blockers.push({ id: 'model-none', message: '还没有可用的模型', action: toModels })
    } else if (!input.bundle.installed) {
      blockers.push({ id: 'model-missing', message: `「${input.bundle.bundle.name}」还没有下载完`, action: toModels })
    }
  }

  if (input.remote) {
    if (!input.remote.modelPath?.trim()) {
      blockers.push({ id: 'remote-path', message: `「${input.remote.name}」还没有设置模型位置`, action: { label: '去设置', to: '/settings/devices' } })
    }
  } else if (input.engine && input.engine.state !== 'ready') {
    const target = input.setupDone ? '/settings/devices' : '/setup'
    if (input.engine.installing) {
      const percent = Math.max(0, Math.min(100, Math.round(input.engine.installing.percent)))
      blockers.push({ id: 'engine', message: `引擎正在安装 · ${percent}%`, action: { label: '查看', to: target } })
    } else {
      blockers.push({ id: 'engine', message: '引擎未就绪', action: { label: input.setupDone ? '去设置' : '去准备', to: target } })
    }
  }

  const adapters = normalizeCanvasAdapters(input.canvas?.adapters)
  // Until the library has loaded nothing is known to be missing.
  const missing = input.catalog
    ? adapterStatuses(adapters, input.catalog.adapters).filter((item) => !item.installed)
    : []
  if (missing.length) {
    blockers.push({
      id: 'adapters',
      message: `LoRA ${missing.map((item) => `「${item.name}」`).join('')}找不到了，请移除或重新安装`,
      action: { label: '去模型库', to: '/models' },
    })
  }
  if (input.remote && adapters.length) {
    blockers.push({ id: 'remote-adapters', message: '在其他电脑上运行时暂不支持 LoRA，请移除 LoRA 或改回这台电脑' })
  }

  if (input.canvas) blockers.push(...(input.inputBlockers ?? []))

  const prompt = input.canvas ? compileCanvasPrompt(input.canvas) : null
  if (prompt && !prompt.ok) blockers.push({ id: 'prompt', message: prompt.errors[0] ?? '描述还不完整' })

  return { blockers, prompt }
}

export interface RerunCheck {
  ok: boolean
  reason?: string
}

/**
 * Whether a finished card can run again. A canvas made only of regions has an
 * empty `prompt` but a valid layout, so eligibility is the compiled prompt,
 * never the raw text field.
 */
export function rerunEligibility(
  canvas: Pick<ProjectCanvas, 'id' | 'prompt' | 'summary' | 'layers' | 'width' | 'height'>,
  state: { busy: boolean; submitting: boolean },
): RerunCheck {
  if (state.submitting) return { ok: false, reason: '正在提交' }
  if (state.busy) return { ok: false, reason: '这个画面或它的结果正在生成' }
  const compiled = compileCanvasPrompt(canvas)
  if (!compiled.ok) return { ok: false, reason: compiled.errors[0] }
  return { ok: true }
}
