import type { TrainerRunInput } from '@shared/types'

/** The trainer window's form. Everything is kept as text so inputs stay editable. */
export interface TrainingForm {
  hostId: string
  versionId: string
  weights: string
  dataset: string
  runName: string
  algo: string
  steps: string
  lr: string
  dim: string
  alpha: string
  batch: string
  resolution: string
  overrides: string
}

export type TrainerAction = TrainerRunInput['action']
export type TrainingFormErrors = Partial<Record<keyof TrainingForm, string>>

export const ALGOS = ['lora', 'locon', 'loha', 'lokr', 'dora', 'oft', 'boft', 'ia3', 'full'] as const

export const DEFAULT_TRAINING_FORM: TrainingForm = {
  hostId: 'local',
  versionId: '',
  weights: '',
  dataset: '',
  runName: 'moss-lora',
  algo: 'lora',
  steps: '4000',
  lr: '1e-4',
  dim: '32',
  alpha: '32',
  batch: '1',
  resolution: '1024',
  overrides: '',
}

export const TRAINING_FORM_KEY = 'mossstudio:trainer-form'

const DIGITS = /^\d+$/
const DECIMAL = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i
const RUN_NAME = /^[A-Za-z0-9_-]+$/

const LIMITS: Record<keyof TrainingForm, number> = {
  hostId: 80,
  versionId: 120,
  weights: 4096,
  dataset: 4096,
  runName: 120,
  algo: 80,
  steps: 7,
  lr: 40,
  dim: 20,
  alpha: 20,
  batch: 20,
  resolution: 4,
  overrides: 8000,
}

/** Keep only characters a run name may contain. */
export function sanitizeRunName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, LIMITS.runName)
}

export function digitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, '')
}

/** Turn whatever was stored into a usable form; anything malformed falls back to its default. */
export function sanitizeTrainingForm(raw: unknown): TrainingForm {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const form = { ...DEFAULT_TRAINING_FORM }
  for (const key of Object.keys(DEFAULT_TRAINING_FORM) as Array<keyof TrainingForm>) {
    const value = source[key]
    if (typeof value === 'string' && value.length <= LIMITS[key]) form[key] = value
  }
  if (!(ALGOS as readonly string[]).includes(form.algo)) form.algo = DEFAULT_TRAINING_FORM.algo
  if (!form.hostId.trim()) form.hostId = 'local'
  form.runName = sanitizeRunName(form.runName) || DEFAULT_TRAINING_FORM.runName
  for (const key of ['steps', 'dim', 'batch', 'resolution'] as const) {
    if (!DIGITS.test(form[key])) form[key] = DEFAULT_TRAINING_FORM[key]
  }
  for (const key of ['lr', 'alpha'] as const) {
    if (!DECIMAL.test(form[key])) form[key] = DEFAULT_TRAINING_FORM[key]
  }
  return form
}

export function loadTrainingForm(storage: Pick<Storage, 'getItem'> | null = safeStorage()): TrainingForm {
  try {
    const text = storage?.getItem(TRAINING_FORM_KEY)
    return sanitizeTrainingForm(text ? JSON.parse(text) : null)
  } catch {
    return { ...DEFAULT_TRAINING_FORM }
  }
}

export function saveTrainingForm(form: TrainingForm, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(TRAINING_FORM_KEY, JSON.stringify(form))
  } catch {
    // Storage full or unavailable: the form still works, it just isn't remembered.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function needsDataset(action: TrainerAction): boolean {
  return action === 'train' || action === 'inspect_data' || action === 'cache_text' || action === 'cache_latents'
}

function integerIn(value: string, min: number, max: number): boolean {
  if (!DIGITS.test(value)) return false
  const number = Number(value)
  return number >= min && number <= max
}

/** Field-level problems that block starting `action`. Empty object means ready. */
export function trainingFormErrors(form: TrainingForm, action: TrainerAction = 'train'): TrainingFormErrors {
  const errors: TrainingFormErrors = {}
  if (!form.versionId) errors.versionId = '先在训练页准备训练器'
  if (!form.weights.trim()) errors.weights = '选择底模权重所在的文件夹'
  if (needsDataset(action) && !form.dataset.trim()) errors.dataset = '选择训练图片所在的文件夹'
  if (!form.runName || !RUN_NAME.test(form.runName)) errors.runName = '名称只能包含字母、数字、- 和 _'
  if (!integerIn(form.steps, 1, 1_000_000)) errors.steps = '步数需要是 1 到 1000000 之间的整数'
  if (!integerIn(form.resolution, 64, 4096)) errors.resolution = '边长需要是 64 到 4096 之间的整数'
  if (!DECIMAL.test(form.lr)) errors.lr = '学习率需要是数字，例如 1e-4'
  if (!integerIn(form.dim, 1, 4096)) errors.dim = '需要是正整数'
  if (!DECIMAL.test(form.alpha)) errors.alpha = '需要是数字'
  if (!integerIn(form.batch, 1, 1024)) errors.batch = '需要是正整数'
  return errors
}

/** The first blocking problem, in the order the form shows its fields. */
export function firstTrainingFormError(form: TrainingForm, action: TrainerAction = 'train'): string | null {
  return Object.values(trainingFormErrors(form, action))[0] ?? null
}

export function toTrainerRunInput(form: TrainingForm, action: TrainerAction): TrainerRunInput {
  return {
    versionId: form.versionId,
    action,
    runName: form.runName,
    weights: form.weights.trim(),
    dataset: form.dataset.trim(),
    algo: form.algo,
    steps: Number(form.steps),
    lr: form.lr,
    dim: form.dim,
    alpha: form.alpha,
    batch: form.batch,
    resolution: Number(form.resolution),
    overrides: form.overrides,
  }
}

/** `KEY=VALUE` lines become `--set KEY=VALUE`; blanks and `#` comments are skipped. */
export function overrideArgs(overrides: string): string[] {
  return overrides
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => `--set ${line}`)
}

/** The commands the trainer runs for this form, for people who want to run them by hand. */
export function buildTrainingCommand(form: TrainingForm): string {
  const name = form.runName || DEFAULT_TRAINING_FORM.runName
  const resolution = Number(form.resolution || DEFAULT_TRAINING_FORM.resolution)
  const extra = overrideArgs(form.overrides)
  return [
    `kohakumoss-config new train --weights ${form.weights.trim() || '<weights>'} --data ${form.dataset.trim() || '<dataset>'} --source kohya --algo ${form.algo} --name ${name} --steps ${form.steps || DEFAULT_TRAINING_FORM.steps}`,
    [
      `kogine run scripts/train/moss.py --config configs/user/${name}.py`,
      `--set LR=${form.lr || DEFAULT_TRAINING_FORM.lr}`,
      `--set DIM=${form.dim || DEFAULT_TRAINING_FORM.dim}`,
      `--set ALPHA=${form.alpha || DEFAULT_TRAINING_FORM.alpha}`,
      `--set MICROBATCHES=${form.batch || DEFAULT_TRAINING_FORM.batch}`,
      `--set TARGET_AREA=${resolution ** 2}`,
      ...extra,
    ].join(' '),
  ].join('\n')
}
