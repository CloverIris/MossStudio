import type { ProjectCanvas } from '@shared/types'
import { Button } from '../../components/ui'
import { cloverUrl } from '../../lib/clover'

/** The params panel for a picture card: it has no generation settings, only the picture. */
export function ImageCardPanel({
  canvas,
  onUseAsStart,
}: {
  canvas: ProjectCanvas
  onUseAsStart?: (imageCanvasId: string) => void
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 px-5 pb-4 pt-5" data-image-card-panel>
      <div className="flex flex-col gap-1">
        <h2 className="truncate text-control font-semibold text-ink">{canvas.title}</h2>
        <p className="text-caption text-ink-2">导入的图片。把它连到画面上，作为起始图、控制图或参考图。</p>
      </div>
      {canvas.imagePath ? (
        <img
          src={cloverUrl(canvas.imagePath)}
          alt={canvas.title}
          draggable={false}
          className="max-h-[320px] w-full rounded-lg bg-well object-contain"
        />
      ) : (
        <p className="rounded-lg bg-well px-3 py-2.5 text-caption text-ink-2">图片文件找不到了。</p>
      )}
      {onUseAsStart && canvas.imagePath ? (
        <Button tone="primary" size="lg" block onClick={() => onUseAsStart(canvas.id)}>
          用它新建画面
        </Button>
      ) : null}
    </div>
  )
}
