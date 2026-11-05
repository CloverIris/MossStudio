/** An Error whose `code` (E_*) travels to the renderer next to the message (IPC result, HTTP body). */
export interface CodedError extends Error {
  code: string
}

export function codedError(code: string, message: string): CodedError {
  return Object.assign(new Error(message), { code })
}

/** The E_* code of an error thrown by our own code; fs/system codes (ENOENT…) do not count. */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^E_[A-Z0-9_]+$/.test(code) ? code : undefined
}
