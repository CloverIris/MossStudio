// Electron main process for the E2E suite: one frameless window showing the
// E2E renderer build (e2e/app) against the mock backend. No preload, no IPC:
// window.clover comes from the mock. Playwright's _electron launcher drives it.
//
//   electron e2e/electron/main.cjs --e2e-app=<built dir> [--no-sandbox]
const { app, BrowserWindow, protocol } = require('electron')
const { pathToFileURL } = require('node:url')
const { join } = require('node:path')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')

const appDir = process.argv.find((arg) => arg.startsWith('--e2e-app='))?.slice('--e2e-app='.length)
if (!appDir) {
  console.error('missing --e2e-app=<dir>')
  process.exit(2)
}

app.setPath('userData', mkdtempSync(join(tmpdir(), 'mossstudio-e2e-user-')))
app.commandLine.appendSwitch('no-sandbox')
// Deterministic pixels for screenshots and contrast sampling.
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('force-color-profile', 'srgb')
app.commandLine.appendSwitch('lang', 'zh-CN')

protocol.registerSchemesAsPrivileged([
  { scheme: 'clover', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

/** Generated output/gallery images: a soft gradient whose hue comes from the path. */
function fixtureImage(url) {
  const path = new URL(url).searchParams.get('path') ?? url
  let hash = 0
  for (const char of path) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const hue = hash % 360
  const size = /(\d{3,4})x(\d{3,4})/.exec(path)
  const width = size ? Number(size[1]) : 1024
  const height = size ? Number(size[2]) : 1024
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue} 55% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 45% 32%)"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <circle cx="${width * 0.62}" cy="${height * 0.4}" r="${Math.min(width, height) * 0.18}" fill="hsl(${(hue + 180) % 360} 60% 80%)" opacity="0.7"/>
</svg>`
}

app.whenReady().then(() => {
  protocol.handle('clover', (request) => new Response(fixtureImage(request.url), {
    headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' },
  }))
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    useContentSize: true,
    frame: false,
    // capturePage fails for hidden windows under xvfb, so the window is always shown.
    show: true,
    backgroundColor: '#1c1c1e',
    webPreferences: { sandbox: false, contextIsolation: true, backgroundThrottling: false, spellcheck: false },
  })
  void win.loadURL(`${pathToFileURL(join(appDir, 'index.html')).href}?scenario=ready#/studio`)
})

app.on('window-all-closed', () => app.quit())
