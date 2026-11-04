import { Box, GraduationCap, LayoutGrid, PencilLine, type LucideIcon } from 'lucide-react'
import type { Settings } from '@shared/types'

export interface AppRoute {
  to: string
  label: string
  description: string
  icon: LucideIcon
  /** Only shown when this optional feature is turned on. */
  feature?: keyof Pick<Settings, 'trainingEnabled'>
}

/** Primary destinations, in the order people use them. */
export const PRIMARY_ROUTES: AppRoute[] = [
  { to: '/studio', label: '创作', description: '描述画面、布置区域并生成', icon: PencilLine },
  { to: '/library', label: '作品', description: '浏览和复用生成过的图片', icon: LayoutGrid },
  { to: '/models', label: '模型', description: '下载和管理模型', icon: Box },
  { to: '/training', label: '训练', description: '训练自己的 LoRA', icon: GraduationCap, feature: 'trainingEnabled' },
]

/** Old routes from before the restructure, and where they live now. */
export const LEGACY_REDIRECTS: Record<string, string> = {
  '/gallery': '/library',
  '/engines': '/settings/devices',
  '/devices': '/settings/devices',
  '/instances': '/settings/devices',
  '/diagnostics': '/studio',
}

export function visibleRoutes(settings: Settings | null): AppRoute[] {
  return PRIMARY_ROUTES.filter((route) => !route.feature || Boolean(settings?.[route.feature]))
}

/** The top-level route a pathname belongs to ('/settings/network' → '/settings'). */
export function routeRoot(pathname: string): string {
  const [, first = ''] = pathname.split('/')
  return `/${first}`
}
