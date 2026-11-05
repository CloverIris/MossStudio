import { describe, expect, it } from 'vitest'
import { DEFAULT_SOURCE } from '@shared/git'
import { schemas } from '@shared/schemas'

describe('DEFAULT_SOURCE', () => {
  it('is an https GitHub repository URL without a trailing slash or .git suffix', () => {
    const url = new URL(DEFAULT_SOURCE)
    expect(url.protocol).toBe('https:')
    expect(url.hostname).toBe('github.com')
    expect(url.pathname.split('/').filter(Boolean)).toHaveLength(2)
    expect(DEFAULT_SOURCE.endsWith('/')).toBe(false)
    expect(DEFAULT_SOURCE.endsWith('.git')).toBe(false)
  })

  it('passes every IPC schema that takes a source', () => {
    expect(schemas.gitBranches.safeParse({ source: DEFAULT_SOURCE }).success).toBe(true)
    expect(schemas.gitCommits.safeParse({ branch: 'main', source: DEFAULT_SOURCE }).success).toBe(true)
    expect(schemas.instanceCreate.safeParse({ branch: 'main', commit: 'abcdef0', source: DEFAULT_SOURCE }).success).toBe(true)
    expect(schemas.instanceRemoteHost.safeParse({ hostId: 'h', source: DEFAULT_SOURCE }).success).toBe(true)
  })
})
