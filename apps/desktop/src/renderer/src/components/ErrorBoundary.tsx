import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from './ui'

interface State {
  error: Error | null
  componentStack: string | null
}

/** Keeps one broken page from taking down the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, componentStack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null })
    console.error('[clover] renderer error', error, info.componentStack)
  }

  render(): ReactNode {
    const { error, componentStack } = this.state
    if (!error) return this.props.children
    const details = [error.stack ?? error.message, componentStack].filter(Boolean).join('\n')
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-4 overflow-y-auto bg-surface p-8 text-ink">
        <div className="flex max-w-xl flex-col items-center gap-1.5 text-center">
          <h1 className="text-section font-semibold">这个页面出错了</h1>
          <p className="text-ui text-ink-2">
            你的作品和设置不受影响。重新加载通常就能恢复；如果反复出现，请复制下面的信息到 GitHub 或 QQ 群反馈。
          </p>
        </div>
        <div className="flex gap-2">
          <Button tone="primary" size="md" onClick={() => window.location.reload()}>
            重新加载
          </Button>
          <Button size="md" onClick={() => void navigator.clipboard.writeText(details).catch(() => undefined)}>
            复制错误信息
          </Button>
        </div>
        <details className="w-full max-w-2xl">
          <summary className="cursor-pointer text-center text-caption text-ink-2">查看错误详情</summary>
          <pre className="selectable mt-2 max-h-72 overflow-auto rounded-lg bg-well p-3 text-left font-mono text-caption text-ink-2">
            {details}
          </pre>
        </details>
      </div>
    )
  }
}
