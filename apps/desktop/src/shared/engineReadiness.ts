import type { EngineReadiness } from './types'

/** 引擎页与准备清单共用同一份状态文案。 */
export function describeEngineReadiness(readiness: EngineReadiness): string {
  if (readiness.installing) {
    const percent = Math.max(0, Math.min(100, Math.round(readiness.installing.percent)))
    return `正在安装 ${readiness.installing.version ?? 'MossInfer'} · ${percent}%`
  }
  if (readiness.state === 'ready') {
    return readiness.lastAttempt?.error ? 'MossInfer 已就绪 · 上次更新失败' : 'MossInfer 已就绪'
  }
  return readiness.reason ?? '尚未准备 MossInfer 引擎；请下载或选择自定义引擎目录'
}
