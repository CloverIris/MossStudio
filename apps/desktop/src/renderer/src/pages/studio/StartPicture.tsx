import { useEffect, useRef } from 'react'
import type { ImageResizeMode } from '@shared/types'
import { cn } from '../../components/ui'
import { cloverUrl } from '../../lib/clover'
import { placement, type Size } from './mask'

const FIT: Record<Exclude<ImageResizeMode, 'fit'>, string> = { crop: 'object-cover', stretch: 'object-fill' }

/**
 * A layout canvas's start picture, shown the way the engine will use it. In
 * fit mode the picture is contained and the empty bands repeat its first and
 * last row (or column), stretched, exactly as the engine fills them.
 */
export function StartPicture({
  path,
  resize = 'crop',
  canvas,
}: {
  path: string
  resize?: ImageResizeMode
  canvas: Size
}): React.JSX.Element {
  const element = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (resize !== 'fit') return
    let alive = true
    const image = new Image()
    image.src = cloverUrl(path)
    void image
      .decode()
      .then(() => {
        const context = element.current?.getContext('2d')
        if (!alive || !context || !image.naturalWidth || !image.naturalHeight) return
        const iw = image.naturalWidth
        const ih = image.naturalHeight
        const place = placement({ width: iw, height: ih }, canvas, 'fit')
        context.clearRect(0, 0, canvas.width, canvas.height)
        context.drawImage(image, place.ox, place.oy, place.w, place.h)
        if (place.bands === 'rows') {
          context.drawImage(image, 0, 0, iw, 1, 0, 0, canvas.width, place.fill)
          context.drawImage(image, 0, ih - 1, iw, 1, 0, place.oy + place.h, canvas.width, place.fill)
        } else if (place.bands === 'columns') {
          context.drawImage(image, 0, 0, 1, ih, 0, 0, place.fill, canvas.height)
          context.drawImage(image, iw - 1, 0, 1, ih, place.ox + place.w, 0, place.fill, canvas.height)
        }
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [path, resize, canvas.width, canvas.height])

  if (resize === 'fit') {
    return (
      <canvas
        ref={element}
        data-init-backdrop
        width={canvas.width}
        height={canvas.height}
        aria-hidden="true"
        className="absolute inset-0 size-full"
      />
    )
  }
  return <img src={cloverUrl(path)} alt="" data-init-backdrop draggable={false} className={cn('absolute inset-0 size-full', FIT[resize])} />
}
