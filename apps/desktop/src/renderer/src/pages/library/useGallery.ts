import { useCallback, useEffect, useRef, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type { GalleryItem, GalleryPage } from '@shared/types'
import { call, onEvent } from '../../lib/api'
import { listRequest, mergeNewest, type LibraryFilters } from './logic'

const PAGE_SIZE = 60

export interface GalleryState {
  items: GalleryItem[]
  total: number
  cursor: string | null
  loading: boolean
  /** Set when the last load failed; the page shows it in place of the grid. */
  error: string | null
  /** True once the first page for the current filters has arrived. */
  loaded: boolean
  reload: () => void
  loadMore: () => Promise<void>
  /** Drops an item locally after it was deleted. */
  remove: (path: string) => void
}

/** Paged gallery listing for the given filters; refreshes when a generation finishes. */
export function useGallery(filters: LibraryFilters): GalleryState {
  const [items, setItems] = useState<GalleryItem[]>([])
  const [total, setTotal] = useState(0)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const sequence = useRef(0)
  const busy = useRef(false)
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  const itemsRef = useRef(items)
  itemsRef.current = items

  const load = useCallback(async (reset: boolean, from: string | null) => {
    if (!reset && busy.current) return
    const run = ++sequence.current
    busy.current = true
    setLoading(true)
    try {
      const page = await call<GalleryPage>(Ipc.galleryList, listRequest(filtersRef.current, { cursor: reset ? null : from, limit: PAGE_SIZE }))
      if (run !== sequence.current) return
      setItems((previous) => (reset ? page.items : [...previous, ...page.items.filter((item) => !previous.some((known) => known.path === item.path))]))
      setCursor(page.nextCursor)
      setTotal(page.total)
      setError(null)
      setLoaded(true)
    } catch (cause) {
      if (run !== sequence.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
      // A failed first page must not leave another filter's results on screen.
      if (reset) {
        setItems([])
        setCursor(null)
        setTotal(0)
      }
      setLoaded(true)
    } finally {
      if (run === sequence.current) {
        busy.current = false
        setLoading(false)
      }
    }
  }, [])

  const key = `${filters.query.trim()}|${filters.projectId}|${filters.time}`
  useEffect(() => {
    void load(true, null)
  }, [key, load])

  // New results: merge the newest page in at the top instead of resetting, so the
  // scroll position, loaded pages and the open detail panel stay as they are.
  const refreshTop = useCallback(async () => {
    if (busy.current) return
    try {
      const page = await call<GalleryPage>(Ipc.galleryList, listRequest(filtersRef.current, { limit: PAGE_SIZE }))
      const previous = itemsRef.current
      const merged = mergeNewest(previous, page.items)
      const added = merged.length - previous.length
      if (added > 0) {
        itemsRef.current = merged
        setItems(merged)
        // Newer files push the rest of the listing down by the same amount.
        setCursor((value) => (value && /^\d+$/.test(value) ? String(Number(value) + added) : value))
      }
      setTotal(page.total)
    } catch {
      // the next manual refresh shows the error
    }
  }, [])

  useEffect(() => onEvent(Events.galleryChanged, () => void refreshTop()), [refreshTop])

  const cursorRef = useRef(cursor)
  cursorRef.current = cursor
  const loadMore = useCallback(async () => {
    if (cursorRef.current && !busy.current) await load(false, cursorRef.current)
  }, [load])

  const reload = useCallback(() => void load(true, null), [load])

  const remove = useCallback((path: string) => {
    setItems((previous) => previous.filter((item) => item.path !== path))
    setTotal((value) => Math.max(0, value - 1))
    // The cursor is an offset into the listing; one fewer file shifts it back by one.
    setCursor((value) => (value && /^\d+$/.test(value) ? String(Math.max(0, Number(value) - 1)) : value))
  }, [])

  return { items, total, cursor, loading, error, loaded, reload, loadMore, remove }
}
