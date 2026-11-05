import type { ProjectCanvas, ProjectLayer } from '@shared/types'

export function layer(patch: Partial<ProjectLayer> = {}): ProjectLayer {
  return { id: 'r1', kind: 'object', caption: 'a red bicycle', bbox: [0, 0, 512, 512], visible: true, locked: false, opacity: 1, ...patch }
}

export function canvas(patch: Partial<ProjectCanvas> = {}): ProjectCanvas {
  return {
    id: 'c1',
    kind: 'layout',
    title: '画面 1',
    x: 0,
    y: 0,
    width: 1024,
    height: 1024,
    summary: { caption: '', meta: [], canvas: 'single' },
    layers: [],
    prompt: '',
    negative: '',
    seed: 7,
    steps: 20,
    cfg: 3,
    ...patch,
  }
}
