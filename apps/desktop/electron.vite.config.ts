import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { updateBuildDefines } from './src/shared/updateKeys'

const r = (p: string) => resolve(__dirname, p)

export default defineConfig({
  main: {
    // Test keys and the feed override exist only when the BUILD env sets them (CI integration
    // builds); every other build, release included, gets [] and "".
    define: updateBuildDefines(process.env),
    resolve: {
      alias: { '@shared': r('src/shared'), '@main': r('src/main') },
    },
    build: {
      rollupOptions: {
        // Electron's asar-unaware fs (main/install copies app folders that hold app.asar).
        external: ['original-fs'],
        input: {
          index: r('src/main/index.ts'),
          backend: r('src/backend/index.ts'),
        },
      },
    },
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    resolve: {
      alias: { '@shared': r('src/shared'), '@main': r('src/main') },
    },
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: r('src/renderer'),
    resolve: {
      alias: { '@renderer': r('src/renderer/src'), '@shared': r('src/shared') },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: r('src/renderer/index.html'),
          web: r('src/renderer/web.html'),
        },
      },
    },
  },
})
