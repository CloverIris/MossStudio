import type { ReactNode } from 'react'

export function StudioSection({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
  return (
    <section className="studio-section">
      <h2 className="px-3 pt-3 text-ui text-[var(--color-text-secondary)]">{title}</h2>
      {children}
    </section>
  )
}
