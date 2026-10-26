const { createRequire } = require('node:module')
const { join } = require('node:path')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const req = createRequire(join(__dirname, '../apps/desktop/package.json'))
const { app, BrowserWindow, screen } = req('electron')
const output = process.argv[2]
const directory = process.env.CLOVER_UI_SCREENSHOTS
const requested = process.env.CLOVER_UI_SCALE
assert.ok(output && directory && ['native', '1', '1.25', '1.5', '1.75', '2'].includes(requested), 'Run this audit with node tools/test-ui.mjs --dpi')
if (requested !== 'native') app.commandLine.appendSwitch('force-device-scale-factor', requested)
app.setPath('userData', join(output, `dpi-profile-${requested}`))
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  mkdirSync(directory, { recursive: true })
  const display = screen.getPrimaryDisplay()
  if (requested === 'native') {
    writeFileSync(join(directory, 'native-display.json'), JSON.stringify(screen.getAllDisplays(), null, 2))
    console.log(`Native display: ${display.label}, scale ${display.scaleFactor}, work area ${display.workArea.width}x${display.workArea.height} DIP`)
    app.exit(0)
    return
  }
  // Read the production window dimensions so this audit cannot silently drift
  // from the app's default and minimum sizes.
  const windows = readFileSync(join(__dirname, '../apps/desktop/src/main/windows.ts'), 'utf8')
  const match = windows.match(/studio: \{ width: (\d+), height: (\d+), minWidth: (\d+), minHeight: (\d+)/)
  assert.ok(match, 'Production Studio window dimensions were not found')
  const [width, height, minWidth, minHeight] = match.slice(1).map(Number)
  const factor = Number(requested)
  const win = new BrowserWindow({
    width, height, minWidth, minHeight, show: false,
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#e9eef7', height: 44 } } : {}),
    webPreferences: { backgroundThrottling: false },
  })
  const errors = []
  win.webContents.on('console-message', (details) => { if (details.level === 'error') errors.push(details.message) })
  const evaluate = async (code) => {
    try { return await win.webContents.executeJavaScript(code) }
    catch (error) { throw new Error(`Renderer evaluation failed: ${code}; ${errors.join('\n')}`, { cause: error }) }
  }
  const waitFor = async (code) => {
    const end = Date.now() + 5000
    while (!await evaluate(code)) {
      if (Date.now() > end) throw new Error(`Timed out: ${code}; ${errors.join('\n')}`)
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  }
  const rows = []
  try {
    await win.loadFile(join(output, 'index.html'), { query: { dpi: '1' }, hash: '/studio' })
    assert.equal(win.webContents.getZoomFactor(), 1, 'DPI audit must not use page zoom')
    assert.ok(Math.abs(await evaluate('devicePixelRatio') - factor) < 0.02, 'The requested device scale did not apply')
    const cases = [
      { name: 'default', bounds: { width, height }, available: display.workArea },
      { name: 'work-area', bounds: display.workArea, available: display.workArea },
      { name: '1080p-work-area', bounds: { width: Math.floor(1920 / factor), height: Math.floor(1080 / factor) - 40 }, available: { width: Math.floor(1920 / factor), height: Math.floor(1080 / factor) - 40 } },
    ]
    for (const profile of cases) {
      win.setBounds({ x: display.workArea.x, y: display.workArea.y, ...profile.bounds })
      for (const page of ['studio', 'settings']) {
        await evaluate(`location.hash = ${JSON.stringify(`/${page}`)}`)
        await waitFor(page === 'studio' ? 'Array.from(document.querySelectorAll("main textarea")).some(element => element.getClientRects().length && element.placeholder === "描述画面、文字、风格与布局。")' : 'Array.from(document.querySelectorAll("h1")).some(element => element.getClientRects().length && element.textContent === "设置")')
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        await win.webContents.capturePage()
        await new Promise(resolve => setTimeout(resolve, 220))
        const metrics = await evaluate(`(() => {
          const box = element => { if (!element) return null; const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, fontSize: parseFloat(style.fontSize), lineHeight: style.lineHeight, scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight, clientWidth: element.clientWidth, clientHeight: element.clientHeight } }
          const visible = element => element.getClientRects().length && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0
          const histogram = {}
          const walker = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT)
          while (walker.nextNode()) {
            const node = walker.currentNode
            if (!node.textContent.trim() || !visible(node.parentElement)) continue
            const size = getComputedStyle(node.parentElement).fontSize
            histogram[size] = (histogram[size] ?? 0) + 1
          }
          const inputs = Array.from(document.querySelectorAll('main input.app-input, main select.app-input, main textarea.app-input')).filter(visible)
          const generate = Array.from(document.querySelectorAll('main button')).find(element => visible(element) && element.textContent.includes('开始生成'))
          const canvas = Array.from(document.querySelectorAll('main div')).find(element => visible(element) && String(element.className).includes('bg-[#121419]'))
          const tiny = Object.entries(histogram).reduce((sum, [size, count]) => sum + (parseFloat(size) < 12 ? count : 0), 0)
          return { dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight }, histogram, textRuns: Object.values(histogram).reduce((sum, count) => sum + count, 0), textBelow12: tiny,
            header: box(document.querySelector('.app-shell > header')), navigation: box(document.querySelector('.page-navigation')), navigationItem: box(document.querySelector('#page-navigation-trigger')), input: box(inputs.find(element => element.tagName !== 'TEXTAREA')), textarea: box(inputs.find(element => element.tagName === 'TEXTAREA')), generate: box(generate), canvas: box(canvas),
            sidebars: Array.from(document.querySelectorAll('main aside')).filter(visible).map(box),
            horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
            scrollContainers: Array.from(document.querySelectorAll('main *')).filter(element => visible(element) && /auto|scroll/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 2).map(element => ({ label: element.textContent.trim().slice(0, 35), ...box(element) })),
            errorBoundary: document.body.textContent.includes('界面出错了'),
          }
        })()`)
        assert.equal(metrics.errorBoundary, false, `Fixture failed on ${page}`)
        const image = await win.webContents.capturePage()
        const png = image.toPNG()
        const file = `${page}-${profile.name}-${Math.round(factor * 100)}.png`
        writeFileSync(join(directory, file), png)
        const bounds = win.getBounds()
        // Fractional scale and native window borders can differ by 1-2 DIP.
        rows.push({ profile: profile.name, page, factor, available: profile.available, bounds, contentBounds: win.getContentBounds(), windowFits: bounds.width <= profile.available.width + 2 && bounds.height <= profile.available.height + 2,
          zoom: win.webContents.getZoomFactor(), screenshot: file, pixels: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, ...metrics })
      }
    }
    assert.equal(errors.length, 0, errors.join('\n'))
    writeFileSync(join(directory, `dpi-${Math.round(factor * 100)}.json`), JSON.stringify({ factor, configured: { width, height, minWidth, minHeight }, display, rows }, null, 2))
    console.log(`DPI ${factor * 100}%: ${rows.map(row => `${row.profile}/${row.page} ${row.viewport.width}x${row.viewport.height} DIP, ${row.pixels.width}x${row.pixels.height} pixels, fits=${row.windowFits}`).join('; ')}`)
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
