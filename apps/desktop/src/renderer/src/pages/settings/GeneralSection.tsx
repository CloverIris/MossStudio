import type { Settings } from '@shared/types'
import { useApp } from '../../store'
import { Group, Row, Section, Segmented } from '../../components/ui'
import { SectionBody, useSaveSettings } from './fields'

export function GeneralSection(): React.JSX.Element {
  const settings = useApp((state) => state.settings)!
  const save = useSaveSettings()

  return (
    <SectionBody>
      <Section title="外观">
        <Group>
          <Row title="主题" description="跟随系统会在系统切换深浅色时一起切换。">
            <Segmented<Settings['theme']>
              label="主题"
              value={settings.theme}
              onChange={(theme) => void save({ theme })}
              options={[
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
                { value: 'system', label: '跟随系统' },
              ]}
            />
          </Row>
          <Row title="动效" description="跟随系统时，系统开启「减少动态效果」就会关闭界面动画。">
            <Segmented<Settings['uiAnimation']>
              label="动效"
              value={settings.uiAnimation}
              onChange={(uiAnimation) => void save({ uiAnimation })}
              options={[
                { value: 'on', label: '开启' },
                { value: 'off', label: '关闭' },
                { value: 'system', label: '跟随系统' },
              ]}
            />
          </Row>
          <Row title="语言" description="目前只提供简体中文界面。">
            <span className="text-ui text-ink-2">简体中文</span>
          </Row>
        </Group>
      </Section>
    </SectionBody>
  )
}
