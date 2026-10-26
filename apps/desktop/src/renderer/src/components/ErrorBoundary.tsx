import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  error: Error | null
  componentStack: string | null
}

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
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--color-surface)] p-8 text-[var(--color-text)]">
          <h1 className="text-lg font-semibold">界面出错了</h1>
          <pre className="max-h-52 max-w-2xl overflow-auto rounded-lg bg-[var(--color-surface-secondary)] p-3 text-left text-ui leading-5">
            {this.state.error.stack ?? this.state.error.message}
          </pre>
          {this.state.componentStack ? (
            <pre className="max-h-40 max-w-2xl overflow-auto rounded-lg border border-[var(--color-border-subtle)] p-3 text-left text-ui leading-5 text-[var(--color-text-secondary)]">
              {this.state.componentStack}
            </pre>
          ) : null}
          <button
            type="button"
            className="rounded-full bg-accent-500 px-4 py-1.5 text-ui text-white"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
