import assert from 'node:assert/strict'
import test from 'node:test'
import { describeEngineReadiness } from '../apps/desktop/src/shared/engineReadiness.ts'

test('ready 与上次更新失败同时存在时文案不互相矛盾', () => {
  const text = describeEngineReadiness({
    state: 'ready',
    path: 'moss-server',
    lastAttempt: { at: '2026-11-01T00:00:00.000Z', error: 'download failed' },
  })
  assert.equal(text, 'MossInfer 已就绪 · 上次更新失败')
})

test('安装中的 readiness 直接提供百分比文案', () => {
  const text = describeEngineReadiness({
    state: 'missing',
    path: null,
    installing: { phase: 'downloading', percent: 42.4, version: 'v2.1.1' },
  })
  assert.equal(text, '正在安装 v2.1.1 · 42%')
})

test('已有引擎直接显示就绪，不引入额外验证步骤', () => {
  const text = describeEngineReadiness({ state: 'ready', path: 'moss-server' })
  assert.equal(text, 'MossInfer 已就绪')
})

test('缺失状态提供准备动作', () => {
  const text = describeEngineReadiness({ state: 'missing', path: null })
  assert.match(text, /下载或选择自定义引擎目录/)
})
