import { Copy } from 'lucide-react'
import { IconButton, useCopyText } from '../ui'
import { cn } from '../cn'

/**
 * One prompt, shown the same way everywhere: a caption heading, a copy
 * button, and the text in a selectable well. Use one block per prompt
 * (描述, 不想出现的内容); notes about the prompt go below it as a caption.
 */
export function PromptBlock({
  title,
  text,
  empty = '没有记录',
  className,
}: {
  title: string
  text: string | null | undefined
  /** Shown in the well when there is no text. */
  empty?: string
  className?: string
}): React.JSX.Element {
  const copy = useCopyText()
  const value = text?.trim() ?? ''
  return (
    <section aria-label={title} data-prompt-block={title} className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 className="text-caption font-medium text-ink-2">{title}</h3>
        {value ? (
          <IconButton label={`复制${title}`} className="-my-1 size-7" onClick={() => void copy(value, `已复制${title}`)}>
            <Copy className="size-3.5" strokeWidth={1.6} />
          </IconButton>
        ) : null}
      </div>
      <p className="selectable max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-well px-3 py-2.5 text-ui leading-relaxed text-ink [overflow-wrap:anywhere]">
        {value || <span className="text-ink-2">{empty}</span>}
      </p>
    </section>
  )
}
