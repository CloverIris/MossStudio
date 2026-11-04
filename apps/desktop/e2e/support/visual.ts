import { resolve } from 'node:path'
import type { Page } from 'playwright-core'
import { expect } from 'vitest'

export type AuditRule = 'border' | 'hr' | 'palette' | 'contrast' | 'overflow'

export interface AuditAllowance {
  selector: string
  rules: AuditRule[]
  /** Why this is not a violation of the visual system. Required. */
  reason: string
}

export interface Violation {
  rule: AuditRule
  element: string
  detail: string
}

/**
 * The only places the visual rules are knowingly bent. Keep this short; every
 * entry says why.
 */
export const AUDIT_ALLOWLIST: AuditAllowance[] = [
  {
    selector: '[role="switch"] > span',
    rules: ['palette'],
    reason: 'The switch knob is white on the accent fill in both themes, as in the approved System/HiSettings mockups.',
  },
]

const AUDIT_SCRIPT = resolve(import.meta.dirname, 'audit.browser.js')

async function ensureAudit(page: Page): Promise<void> {
  const loaded = await page.evaluate(() => typeof (window as unknown as { __audit?: unknown }).__audit === 'function')
  if (!loaded) await page.addScriptTag({ path: AUDIT_SCRIPT })
}

export async function audit(page: Page, extra: AuditAllowance[] = []): Promise<Violation[]> {
  await ensureAudit(page)
  return page.evaluate(
    (allow) => (window as unknown as { __audit: (options: unknown) => Violation[] }).__audit({ allow }),
    [...AUDIT_ALLOWLIST, ...extra],
  )
}

export async function clippedText(page: Page): Promise<string[]> {
  await ensureAudit(page)
  return page.evaluate(() => (window as unknown as { __clippedText: () => string[] }).__clippedText())
}

/** Fail with every violation listed (one per line), not just the first. */
export async function expectVisualRules(page: Page, context: string, extra: AuditAllowance[] = []): Promise<void> {
  const violations = await audit(page, extra)
  const lines = violations.map((item) => `  [${item.rule}] ${item.element}: ${item.detail}`)
  expect(lines, `${context}: visual rule violations`).toEqual([])
}
