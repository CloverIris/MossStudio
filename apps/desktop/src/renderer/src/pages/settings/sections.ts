/** Settings sections, in the order they appear. The URL decides which one is open. */
export type SettingsSectionId = 'general' | 'devices' | 'storage' | 'network' | 'features' | 'updates' | 'about'

export interface SettingsSection {
  id: SettingsSectionId
  label: string
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'general', label: '通用' },
  { id: 'devices', label: '设备与引擎' },
  { id: 'storage', label: '存储' },
  { id: 'network', label: '网络' },
  { id: 'features', label: '功能' },
  { id: 'updates', label: '通知与更新' },
  { id: 'about', label: '关于' },
]

const KNOWN = new Set<string>(SETTINGS_SECTIONS.map((section) => section.id))

/** Section names used by older builds and links, mapped to where they live now. */
const ALIASES: Record<string, SettingsSectionId> = {
  appearance: 'general',
  engine: 'devices',
  engines: 'devices',
  remote: 'devices',
  hosts: 'devices',
  lan: 'features',
  alerts: 'updates',
  notifications: 'updates',
  diagnostics: 'about',
}

/** `/settings/network` → 'network'. Bare `/settings` and unknown names open 通用. */
export function sectionFromPath(pathname: string): SettingsSectionId {
  const [, root, segment = ''] = pathname.split('/')
  if (root !== 'settings') return 'general'
  const name = segment.toLowerCase()
  if (KNOWN.has(name)) return name as SettingsSectionId
  return ALIASES[name] ?? 'general'
}

export function sectionPath(id: SettingsSectionId): string {
  return `/settings/${id}`
}

/** True when the URL already names this section exactly (no redirect needed). */
export function isCanonicalSectionPath(pathname: string): boolean {
  return pathname === sectionPath(sectionFromPath(pathname))
}

export function sectionLabel(id: SettingsSectionId): string {
  return SETTINGS_SECTIONS.find((section) => section.id === id)?.label ?? '设置'
}
