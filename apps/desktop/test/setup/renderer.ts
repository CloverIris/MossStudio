import { beforeEach, vi } from 'vitest'
import { guardedFetch } from '../helpers/network'

beforeEach(() => {
  vi.stubGlobal('fetch', guardedFetch)
  localStorage.clear()
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.uiAnimation
  delete document.documentElement.dataset.acrylic
})
