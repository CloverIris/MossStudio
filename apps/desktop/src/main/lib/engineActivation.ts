/**
 * Switching the active engine build restarts the engine, which ends any job
 * running on it. Activation therefore runs under one lock: new engine jobs
 * wait for it (`waitForEngineActivation`) instead of starting on a build that
 * is about to be stopped, and a background update can ask, inside the lock,
 * whether now is a good moment (`canActivate`) and otherwise try again later.
 */
let pending: Promise<void> | null = null

/** Resolves once no activation is in progress. Engine jobs call this before they start. */
export async function waitForEngineActivation(): Promise<void> {
  while (pending) await pending
}

export function engineActivationInProgress(): boolean {
  return pending !== null
}

export async function withEngineActivation<T>(fn: () => Promise<T>): Promise<T> {
  // Check and take the lock in the same tick, so two callers can never both hold it.
  while (pending) await pending
  let release!: () => void
  pending = new Promise<void>((resolve) => { release = resolve })
  try {
    return await fn()
  } finally {
    pending = null
    release()
  }
}

export interface ActivationGate {
  /** Checked inside the lock; false means "jobs are running, not now". */
  canActivate: () => Promise<boolean>
  /** Called once when activation has to wait, so the UI can say so. */
  onWaiting?: () => void
  retryMs?: number
  /** Give up after this long and leave the current engine in place. */
  timeoutMs?: number
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export class ActivationTimeoutError extends Error {}

/**
 * Run `activate` under the activation lock. Without a gate it runs as soon as
 * the lock is free (a person asked for this install). With a gate it waits
 * until `canActivate` says yes, re-checking every `retryMs`.
 */
export async function activateWhenAllowed<T>(activate: () => Promise<T>, gate?: ActivationGate): Promise<T> {
  if (!gate) return withEngineActivation(activate)
  const sleep = gate.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = gate.now ?? Date.now
  const deadline = now() + (gate.timeoutMs ?? 12 * 60 * 60_000)
  let announced = false
  for (;;) {
    if (gate.signal?.aborted) throw new Error('已取消')
    const result = await withEngineActivation(async () => (await gate.canActivate()) ? { done: true as const, value: await activate() } : { done: false as const })
    if (result.done) return result.value
    if (!announced) { announced = true; gate.onWaiting?.() }
    if (now() >= deadline) throw new ActivationTimeoutError('一直有任务在运行，没有切换到新版本引擎；稍后会再试')
    await sleep(gate.retryMs ?? 30_000)
  }
}
