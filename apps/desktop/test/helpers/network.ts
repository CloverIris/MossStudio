/**
 * Unit tests must never reach the real network. The setup files install this
 * guard as the global `fetch`; loopback URLs (local fixture servers started by a
 * test) still go through the real implementation.
 */
const realFetch = globalThis.fetch

export function isLoopback(input: string | URL | Request): boolean {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
}

export const guardedFetch: typeof fetch = (input, init) => {
  if (isLoopback(input as string | URL | Request)) return realFetch(input, init)
  const target = typeof input === 'string' || input instanceof URL ? String(input) : (input as Request).url
  return Promise.reject(new Error(`unit tests must not reach the network (fetch ${target}); stub fetch for this test`))
}
