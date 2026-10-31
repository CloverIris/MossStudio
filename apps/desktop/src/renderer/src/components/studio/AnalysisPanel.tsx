import { AlertTriangle, GitBranch, RefreshCw, ScanSearch } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { GbcStatus } from '@shared/gbc'
import { call } from '../../lib/api'
import { Button, StatusDot } from '../ui'

/**
 * Image-analysis tab: tells the user whether GBC is actually usable before they
 * click through, instead of sending them into a modal that can only fail.
 */
export function AnalysisPanel({ onRun, onManage }: {
  onRun: () => void
  onManage: () => void
}): React.JSX.Element {
  const [status, setStatus] = useState<GbcStatus | null>(null)
  const [checking, setChecking] = useState(false)

  async function check(): Promise<void> {
    setChecking(true)
    try {
      setStatus(await call<GbcStatus>(Ipc.gbcStatus, {}))
    } catch {
      setStatus(null)
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void check()
  }, [])

  const failing = (status?.checks ?? []).filter((item) => !item.ok).slice(0, 3)

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-caption">
          <StatusDot status={checking ? 'unknown' : status?.available ? 'ok' : status ? 'warn' : 'unknown'} />
          <span className="truncate">
            {checking ? '正在检测 GBC…' : status?.available ? 'GBC 可用' : status ? 'GBC 未就绪' : '状态未知'}
          </span>
        </span>
        <Button tone="ghost" onClick={() => void check()} disabled={checking}>
          <span className="inline-flex items-center gap-1.5"><RefreshCw className="size-3.5" /> 检测</span>
        </Button>
      </div>

      {status?.version ? (
        <p className="truncate font-mono text-caption text-[var(--color-text-tertiary)]">{status.version}</p>
      ) : null}

      {failing.length ? (
        <ul className="space-y-1 rounded-[5px] border border-amber-500/20 bg-amber-500/[0.06] p-2">
          {failing.map((item) => (
            <li key={item.id} className="flex items-start gap-1.5 text-caption leading-4">
              <AlertTriangle className="mt-0.5 size-3 shrink-0 text-amber-400" />
              <span className="min-w-0">
                <span className="text-amber-200/90">{item.label}</span>
                <span className="text-[var(--color-text-tertiary)]"> · {item.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="text-caption leading-5 text-[var(--color-text-secondary)]">
        从参考图提取区域、文字和层级描述，导入当前画布继续编辑。
      </p>
      <Button tone="primary" className="w-full" onClick={onRun}>
        <span className="inline-flex items-center gap-1.5"><ScanSearch className="size-4" /> 选择图片并解析</span>
      </Button>
      <Button tone="ghost" className="w-full" onClick={onManage}>
        <span className="inline-flex items-center gap-1.5"><GitBranch className="size-4" /> 管理解析工具</span>
      </Button>
      <p className="text-caption leading-4 text-[var(--color-text-tertiary)]">
        GBC 是可选工具；缺少它不影响画布创作与生成。
      </p>
    </div>
  )
}
