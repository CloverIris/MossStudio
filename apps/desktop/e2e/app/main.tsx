// Same entry as src/renderer/src/main.tsx, with the mock backend installed first.
import './e2e.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installHarness } from './harness'
import type { useApp } from '@renderer/store'

declare global {
  interface Window {
    __store: () => ReturnType<typeof useApp.getState>
  }
}

installHarness(() => {
  document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  // The App module reads window.clover at import time in places, so load it after install.
  void Promise.all([import('@renderer/App'), import('@renderer/store')]).then(([{ App }, { useApp }]) => {
    // Read-only window into the renderer store, for assertions on derived state.
    window.__store = () => useApp.getState()
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
})
