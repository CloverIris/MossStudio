import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRAINING_FORM,
  TRAINING_FORM_KEY,
  buildTrainingCommand,
  firstTrainingFormError,
  loadTrainingForm,
  overrideArgs,
  sanitizeRunName,
  sanitizeTrainingForm,
  saveTrainingForm,
  toTrainerRunInput,
  trainingFormErrors,
  type TrainingForm,
} from '@renderer/pages/training/trainingForm'

const filled: TrainingForm = {
  ...DEFAULT_TRAINING_FORM,
  versionId: 'v1',
  weights: ' /models/base ',
  dataset: '/data/cats',
  runName: 'cats',
  steps: '2000',
}

describe('trainingForm persistence', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(loadTrainingForm()).toEqual(DEFAULT_TRAINING_FORM)
  })

  it('remembers the last form values', () => {
    saveTrainingForm(filled)
    expect(loadTrainingForm()).toEqual(filled)
  })

  it('falls back to defaults for corrupt storage', () => {
    localStorage.setItem(TRAINING_FORM_KEY, '{not json')
    expect(loadTrainingForm()).toEqual(DEFAULT_TRAINING_FORM)
  })

  it('works without storage', () => {
    expect(loadTrainingForm(null)).toEqual(DEFAULT_TRAINING_FORM)
    expect(() => saveTrainingForm(filled, null)).not.toThrow()
  })

  it('ignores a storage that throws on write', () => {
    expect(() =>
      saveTrainingForm(filled, {
        setItem: () => {
          throw new Error('quota')
        },
      }),
    ).not.toThrow()
  })

  it('replaces malformed fields one by one and keeps the rest', () => {
    const form = sanitizeTrainingForm({
      ...filled,
      algo: 'rm -rf',
      steps: '12a',
      lr: 'fast',
      dim: 7,
      runName: 'my run!',
      hostId: '',
      extra: 'dropped',
    })
    expect(form.algo).toBe('lora')
    expect(form.steps).toBe(DEFAULT_TRAINING_FORM.steps)
    expect(form.lr).toBe(DEFAULT_TRAINING_FORM.lr)
    expect(form.dim).toBe(DEFAULT_TRAINING_FORM.dim)
    expect(form.runName).toBe('my-run-')
    expect(form.hostId).toBe('local')
    expect(form.weights).toBe(filled.weights)
    expect(form).not.toHaveProperty('extra')
  })

  it('rejects over-long strings', () => {
    expect(sanitizeTrainingForm({ weights: 'x'.repeat(5000) }).weights).toBe('')
  })
})

describe('trainingForm validation', () => {
  it('accepts a complete form', () => {
    expect(trainingFormErrors(filled)).toEqual({})
    expect(firstTrainingFormError(filled)).toBeNull()
  })

  it('needs a version, weights and (for training) a dataset', () => {
    const errors = trainingFormErrors({ ...filled, versionId: '', weights: '', dataset: '' })
    expect(Object.keys(errors)).toEqual(['versionId', 'weights', 'dataset'])
    expect(firstTrainingFormError({ ...filled, versionId: '' })).toBe('先在训练页准备训练器')
  })

  it('does not require a dataset for export or sample', () => {
    expect(trainingFormErrors({ ...filled, dataset: '' }, 'export')).toEqual({})
    expect(trainingFormErrors({ ...filled, dataset: '' }, 'cache_latents').dataset).toBeDefined()
  })

  it('checks number ranges and formats', () => {
    const errors = trainingFormErrors({ ...filled, steps: '0', resolution: '32', lr: '1e', dim: '', batch: 'x', alpha: '-' })
    expect(Object.keys(errors).sort()).toEqual(['alpha', 'batch', 'dim', 'lr', 'resolution', 'steps'])
    expect(trainingFormErrors({ ...filled, lr: '3.5e-5', alpha: '16.5' })).toEqual({})
  })

  it('rejects run names the trainer cannot use', () => {
    expect(trainingFormErrors({ ...filled, runName: 'a b' }).runName).toBeDefined()
    expect(sanitizeRunName('a b/c')).toBe('a-b-c')
  })
})

describe('trainingForm commands', () => {
  it('builds the trainer run input with numbers and trimmed paths', () => {
    expect(toTrainerRunInput(filled, 'train')).toMatchObject({
      versionId: 'v1',
      action: 'train',
      weights: '/models/base',
      steps: 2000,
      resolution: 1024,
    })
  })

  it('turns KEY=VALUE lines into --set flags and skips comments', () => {
    expect(overrideArgs('A=1\n# B=2\n\n  C=3  \nnoequals')).toEqual(['--set A=1', '--set C=3'])
  })

  it('previews both commands with placeholders for missing paths', () => {
    const command = buildTrainingCommand({ ...DEFAULT_TRAINING_FORM, overrides: 'SAVE_EVERY=250' })
    const [config, train] = command.split('\n')
    expect(config).toContain('--weights <weights> --data <dataset>')
    expect(config).toContain('--algo lora --name moss-lora --steps 4000')
    expect(train).toContain('--config configs/user/moss-lora.py')
    expect(train).toContain(`--set TARGET_AREA=${1024 ** 2}`)
    expect(train?.endsWith('--set SAVE_EVERY=250')).toBe(true)
  })
})
