import { describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { catalogOverrideDir, contentDir } from '@main/lib/content'

describe('catalogOverrideDir', () => {
  it('is the source tree in development, so an edit to models.json shows at once', () => {
    expect(contentDir()).not.toBeNull()
    expect(catalogOverrideDir()).toBe(contentDir())
  })

  it('is nothing in a packaged app: its models.json is a fallback, and the catalog on main is read', () => {
    vi.spyOn(app, 'isPackaged', 'get').mockReturnValue(true)
    expect(catalogOverrideDir()).toBeNull()
  })
})
