import { Boxes, Cpu, GraduationCap, Images, LayoutGrid, Package, Settings2, Stethoscope } from 'lucide-react'

export const APP_PAGES = [
  { to: '/studio', label: '创作', description: '提示词、画布与图层布局', icon: LayoutGrid },
  { to: '/engines', label: '引擎', description: '本机与远端推理引擎', icon: Boxes },
  { to: '/models', label: '模型', description: '模型组件、下载与管理', icon: Package },
  { to: '/devices', label: '设备', description: '推理设备与 SSH 连接', icon: Cpu },
  { to: '/training', label: '训练', description: '训练环境与任务', icon: GraduationCap },
  { to: '/gallery', label: '画廊', description: '浏览生成结果与参考图', icon: Images },
  { to: '/diagnostics', label: '诊断', description: '运行状态与问题排查', icon: Stethoscope },
  { to: '/settings', label: '设置', description: '外观、网络与存储', icon: Settings2 },
] as const

export function PageNavigation({ value, onChange }: { value: string; onChange: (route: string) => void }): React.JSX.Element {
  return (
    <nav className="page-navigation no-drag" aria-label="页面导航">
      {APP_PAGES.map((page) => {
        const PageIcon = page.icon
        const active = page.to === value
        return (
          <button
            key={page.to}
            type="button"
            className="page-navigation-item"
            data-route={page.to}
            aria-current={active ? 'page' : undefined}
            aria-label={`${page.label}：${page.description}`}
            title={page.description}
            onClick={() => onChange(page.to)}
          >
            <PageIcon className="size-4 shrink-0" aria-hidden="true" />
            <span>{page.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
