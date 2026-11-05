import { useCallback, useRef, useState } from 'react'

type Next<T> = T | ((previous: T) => T)

/**
 * useState whose latest value is also readable synchronously through a ref.
 * Updates apply to the ref immediately, so a handler that writes and then
 * reads in the same tick (the assistant setting a description and generating)
 * always sees its own write instead of the previous render's value.
 */
export function useLiveState<T>(initial: T | (() => T)): [T, (next: Next<T>) => void, { readonly current: T }] {
  const [value, setValue] = useState(initial)
  const ref = useRef(value)
  const set = useCallback((next: Next<T>) => {
    const resolved = typeof next === 'function' ? (next as (previous: T) => T)(ref.current) : next
    ref.current = resolved
    setValue(resolved)
  }, [])
  return [value, set, ref]
}
