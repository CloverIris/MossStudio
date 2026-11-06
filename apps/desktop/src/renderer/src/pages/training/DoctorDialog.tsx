import { Button, Modal, Pill } from '../../components/ui'

export interface DoctorResult {
  ok: boolean
  output: string
}

/** The result of 环境体检, the same dialog wherever the check is started from. */
export function DoctorDialog({ result, onClose }: { result: DoctorResult | null; onClose: () => void }): React.JSX.Element {
  return (
    <Modal
      open={Boolean(result)}
      onClose={onClose}
      title="环境体检"
      description={result?.ok ? '没有发现问题。' : '发现了问题，详情见下方输出。'}
      width="max-w-3xl"
      footer={
        <Button tone="ghost" size="md" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        <div>
          <Pill tone={result?.ok ? 'ok' : 'warn'}>{result?.ok ? '通过' : '需要处理'}</Pill>
        </div>
        <pre className="selectable max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg bg-well p-3 font-mono text-caption text-ink-2">
          {result?.output || '没有输出'}
        </pre>
      </div>
    </Modal>
  )
}
