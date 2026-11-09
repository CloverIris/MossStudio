import { nameParts } from '@shared/modelName'
import { cn } from '../cn'
import { Tag } from '../ui'

/**
 * A model or part name: the base name, then its variant (INT8, 8 步) as tags.
 * A real space sits before each tag, so the accessible name and copied text
 * read "MOSS-Image SFT INT8", the same as `name`.
 */
export function ModelName({
  item,
  className,
}: {
  item: { name: string; variant?: readonly string[] }
  className?: string
}): React.JSX.Element {
  const { base, variant } = nameParts(item)
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} data-model-name={item.name}>
      <span className="truncate">{base}</span>
      {variant.map((word) => (
        <span key={word} className="contents">
          {' '}
          <Tag>{word}</Tag>
        </span>
      ))}
    </span>
  )
}
