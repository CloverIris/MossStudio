import type { EngineReadiness } from './types'

/** 引擎页与准备清单共用同一份状态文案。 */
export function describeEngineReadiness(readiness: EngineReadiness): string {
  if (readiness.installing) {
    const percent = Math.max(0, Math.min(100, Math.round(readiness.installing.percent)))
    return `正在安装 ${readiness.installing.version ?? 'MossInfer'} · ${percent}%`
  }
  switch (readiness.state) {
    case 'ready':
      return readiness.lastAttempt?.error
        ? 'MossInfer 已就绪 · 上次更新失败'
        : `MossInfer${readiness.engineVersion ? ` ${readiness.engineVersion}` : ''} 已验证并就绪`
    case 'unverified':
      return readiness.reason ?? '引擎已安装但尚未验证，请执行「验证并切换」'
    case 'stale':
      return readiness.reason ?? '当前 GPU 或引擎已变化，请重新验证'
    case 'unsupported':
      return readiness.reason ?? '当前引擎与协议或设备不兼容'
    case 'missing':
      return '尚未准备 MossInfer 引擎；请下载或选择自定义引擎目录'
  }
}
