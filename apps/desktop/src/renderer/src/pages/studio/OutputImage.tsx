import { ImageOff } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../components/ui'
import { cloverUrl } from '../../lib/clover'

/** Result picture with a readable fallback when the file on disk is gone. */
export function OutputImage({
  path,
  alt,
  className,
  compact,
}: {
  path: string
  alt: string
  className?: string
  compact?: boolean
}): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  if (broken) {
    return (
      <span
        title={`图片文件找不到了：${path}`}
        className="flex size-full items-center justify-center px-3 text-center text-caption text-ink-2"
      >
        {compact ? <ImageOff className="size-4 text-ink-3" aria-label="图片文件找不到了" strokeWidth={1.6} /> : '图片文件找不到了'}
      </span>
    )
  }
  return (
    <img
      src={cloverUrl(path)}
      alt={alt}
      draggable={false}
      onError={() => setBroken(true)}
      className={cn('size-full object-cover', className)}
    />
  )
}
