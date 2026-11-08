import { Button, EmptyState, LoadingRow, Modal } from '../../components/ui'
import { cloverUrl } from '../../lib/clover'
import { EMPTY_FILTERS } from '../library/logic'
import { useGallery } from '../library/useGallery'

/** 从作品选择: pick one picture from 作品 to link into a card's input. */
export function GalleryPicker({
  open,
  title,
  onPick,
  onClose,
}: {
  open: boolean
  title: string
  onPick: (path: string) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <Modal open={open} onClose={onClose} title={title} width="max-w-3xl">
      {open ? <GalleryGrid onPick={onPick} /> : null}
    </Modal>
  )
}

function GalleryGrid({ onPick }: { onPick: (path: string) => void }): React.JSX.Element {
  const gallery = useGallery(EMPTY_FILTERS)
  if (gallery.error) return <EmptyState title="作品读取失败" description={gallery.error} />
  if (!gallery.loaded) return <LoadingRow />
  if (!gallery.items.length) return <EmptyState title="还没有作品" />
  return (
    <div className="pb-2">
      <ul data-gallery-picker className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
        {gallery.items.map((item) => (
          <li key={item.path}>
            <button
              type="button"
              aria-label={item.prompt || item.name}
              title={item.prompt || item.name}
              onClick={() => onPick(item.path)}
              className="block aspect-square w-full overflow-hidden rounded-md bg-well transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <img src={cloverUrl(item.path)} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
            </button>
          </li>
        ))}
      </ul>
      {gallery.cursor ? (
        <div className="mt-3 flex justify-center">
          <Button tone="ghost" size="md" disabled={gallery.loading} onClick={() => void gallery.loadMore()}>
            {gallery.loading ? '正在读取…' : '更多'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
