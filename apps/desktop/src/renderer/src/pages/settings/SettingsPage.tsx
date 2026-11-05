import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useApp } from '../../store'
import { Spinner, cn } from '../../components/ui'
import { AboutSection } from './AboutSection'
import { DevicesSection } from './DevicesSection'
import { FeaturesSection } from './FeaturesSection'
import { GeneralSection } from './GeneralSection'
import { NetworkSection } from './NetworkSection'
import { StorageSection } from './StorageSection'
import { UpdatesSection } from './UpdatesSection'
import { SETTINGS_SECTIONS, isCanonicalSectionPath, sectionFromPath, sectionLabel, sectionPath, type SettingsSectionId } from './sections'

const SECTION_COMPONENTS: Record<SettingsSectionId, () => React.JSX.Element> = {
  general: GeneralSection,
  devices: DevicesSection,
  storage: StorageSection,
  network: NetworkSection,
  features: FeaturesSection,
  updates: UpdatesSection,
  about: AboutSection,
}

/**
 * 设置: a section list on the panel tone, the open section on the surface.
 * The section comes from the URL (/settings/<section>), so links and the
 * back button land on the right place.
 */
export function SettingsPage(): React.JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const settings = useApp((state) => state.settings)
  const scroller = useRef<HTMLDivElement>(null)
  // The page stays mounted while other pages are shown; coming back via the
  // rail (bare /settings) reopens the section that was open last.
  const last = useRef<SettingsSectionId>('general')
  const onSettings = location.pathname === '/settings' || location.pathname.startsWith('/settings/')
  const bare = location.pathname.replace(/\/+$/, '') === '/settings'
  if (onSettings && !bare) last.current = sectionFromPath(location.pathname)
  const section = last.current

  // Bare `/settings` and old section names settle on one canonical address.
  useEffect(() => {
    if (onSettings && (bare || !isCanonicalSectionPath(location.pathname))) navigate(sectionPath(section), { replace: true })
  }, [onSettings, bare, location.pathname, section, navigate])

  useEffect(() => { scroller.current?.scrollTo({ top: 0 }) }, [section])

  const Section = SECTION_COMPONENTS[section]

  return (
    <div className="flex h-full min-h-0 bg-surface">
      <nav aria-label="设置分区" className="flex w-60 shrink-0 flex-col gap-0.5 overflow-y-auto bg-panel px-3 py-6">
        <div className="px-3 pb-4 text-title font-semibold text-ink">设置</div>
        {SETTINGS_SECTIONS.map((item) => {
          const current = item.id === section
          return (
            <button
              key={item.id}
              type="button"
              aria-current={current ? 'page' : undefined}
              onClick={() => navigate(sectionPath(item.id))}
              className={cn(
                'flex h-9 shrink-0 items-center rounded-md px-3 text-left text-control text-ink transition-colors',
                current ? 'bg-surface font-semibold' : 'hover:bg-well',
              )}
            >
              {item.label}
            </button>
          )
        })}
      </nav>
      <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
        <div className="flex w-full max-w-[768px] flex-col gap-7 px-14 pb-16 pt-10">
          <h1 className="text-title font-semibold text-ink">{sectionLabel(section)}</h1>
          {settings ? <Section /> : (
            <div className="flex items-center gap-2 text-ui text-ink-2"><Spinner />正在读取设置…</div>
          )}
        </div>
      </div>
    </div>
  )
}
