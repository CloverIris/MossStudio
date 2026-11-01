import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')

// Run the real store and service with IPC/network boundaries replaced by local fixtures.
function loadSource(path, imports = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const exports = {}
  new Function('require', 'exports', outputText)(
    (id) => Object.hasOwn(imports, id) ? imports[id] : require(id),
    exports,
  )
  return exports
}

const channels = loadSource('../apps/desktop/src/shared/channels.ts')
function task(id, patch = {}) {
  return {
    id: `model:${id}`, targetId: id, kind: 'model', label: id, state: 'queued',
    filesTotal: 2, filesDone: 0, bytes: 0, totalBytes: 1000, speedBps: 0,
    updatedAt: '2026-01-01T00:00:00.000Z', ...patch,
  }
}

test('live download updates preserve initial queue order and refresh task data', async (t) => {
  const originalDocument = globalThis.document
  const originalWindow = globalThis.window
  globalThis.document = { documentElement: { dataset: {} } }
  globalThis.window = {
    clover: { acrylic: false },
    matchMedia: () => ({ addEventListener: () => {} }),
  }
  t.after(() => {
    globalThis.document = originalDocument
    globalThis.window = originalWindow
  })
  const listeners = new Map()
  const initial = [task('a'), task('b'), task('c')]
  let responseTask
  const { useApp } = loadSource('../apps/desktop/src/renderer/src/store.ts', {
    '@shared/channels': channels,
    '../../../../../release/models.json': { schema_version: 2, models: [], adapters: [] },
    './lib/api': {
      onEvent: (channel, callback) => listeners.set(channel, callback),
      call: async (channel) => {
        if (channel === channels.Ipc.settingsGet) return { autoCheckUpdates: false }
        if (channel === channels.Ipc.downloadsList) return initial
        if (channel === channels.Ipc.updatesCheck) return { announcements: [] }
        if (channel === channels.Ipc.modelDownload) return responseTask
        return []
      },
    },
  })
  await useApp.getState().init()
  assert.equal(useApp.getState().error, null)
  const ids = () => useApp.getState().downloads.map((item) => item.id)
  const expected = initial.map((item) => item.id)
  assert.deepEqual(ids(), expected)
  const emit = listeners.get(channels.Events.download)
  for (const [id, state] of [
    ['b', 'running'], ['a', 'running'], ['c', 'running'], ['b', 'paused'],
    ['b', 'running'], ['c', 'error'], ['a', 'done'],
  ]) {
    const update = task(id, { state, bytes: 500, updatedAt: '2099-01-01T00:00:00.000Z' })
    emit(update)
    assert.deepEqual(ids(), expected)
    assert.deepEqual(useApp.getState().downloads.find((item) => item.id === update.id), update)
  }
  emit(task('d'))
  expected.push('model:d')
  assert.deepEqual(ids(), expected)
  responseTask = task('b', { state: 'running', bytes: 600 })
  await useApp.getState().downloadModel('b')
  assert.deepEqual(ids(), expected)
  assert.equal(useApp.getState().downloads[1].bytes, 600)
  responseTask = task('adapter', { kind: 'adapter', id: 'adapter:adapter' })
  await useApp.getState().downloadAdapter('adapter')
  assert.deepEqual(ids(), [...expected, 'adapter:adapter'])
})

test('service snapshots keep insertion order across errors, pause and retry', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') })
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline fixture') })
  const service = loadSource('../apps/desktop/src/main/services/models.ts', {
    '@shared/channels': channels,
    '../../../../../release/models.json': { schema_version: 2, models: [], adapters: [] },
    '../lib/events': { emit: () => {} },
    '../lib/paths': { paths: {} },
    './network': { getLastNetwork: () => null },
    './hfNetwork': { fetchHf: async () => { throw new Error('offline fixture') } },
    './hfCredentials': { getHfToken: () => undefined },
    '../lib/disk': { assertFreeSpace: async () => {} },
    './updates': { localReleaseDir: () => null },
    './instances': { listInstances: async () => [] },
    './supervisor': { listJobs: async () => [] },
    './modelImports': {
      importModelFolder: async () => ({ added: 0, duplicates: 0 }),
      readImportedModels: async () => [],
      removeImportedModel: () => {},
      verifyImportedModelFile: async () => true,
    },
    './modelFiles': {
      downloadFile: async () => {},
      fileSize: async () => 0,
      hashFile: async () => '0'.repeat(64),
      materialize: async () => {},
      resolveFiles: async () => ({ sha: '1'.repeat(40), files: [] }),
      safePath: (root, file) => `${root}/${file}`,
      selectFiles: (files) => files,
      validateSnapshot: async () => true,
    },
  })
  const settings = { hfEndpoint: 'http://fixture.invalid' }
  const expected = []
  const ids = () => service.listDownloads().map((item) => item.id)
  for (const id of ['a', 'b', 'c']) {
    t.mock.timers.tick(10)
    expected.push((await service.downloadCustomModel(`fixture/${id}`, settings)).id)
    await new Promise(setImmediate)
    assert.deepEqual(ids(), expected)
  }
  for (const id of [expected[1], expected[0], expected[2]]) {
    t.mock.timers.tick(10)
    service.pauseDownload(id)
    assert.deepEqual(ids(), expected)
  }
  t.mock.timers.tick(10)
  await service.downloadCustomModel('fixture/b', settings)
  await new Promise(setImmediate)
  assert.deepEqual(ids(), expected)
})
