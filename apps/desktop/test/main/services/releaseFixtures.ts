/** Shared builders for release.md documents used by release/updates tests. */
export function releaseDocument(patch: Record<string, unknown> = {}, app: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 2,
    app: { name: 'MossStudio', channel: 'stable', version: '1.2.0', published_at: '2026-10-01T00:00:00Z', notes_url: 'https://example.test/notes', ...app },
    installers: [],
    announcements: [],
    ...patch,
  }
}

export function releaseMarkdown(document: Record<string, unknown> = releaseDocument(), body = '# MossStudio 1.2.0\n\n## 发布说明\n- Faster') {
  return `${body}\n\n\`\`\`json clover-release\n${JSON.stringify(document, null, 2)}\n\`\`\`\n`
}
