import { useEffect, useState } from 'react'
import { Ipc } from '@shared/channels'
import type { ManagedHost, Settings } from '@shared/types'
import { call } from '../../lib/api'
import { featureVisibility } from '../../lib/features'
import { integerInRange, optionalHfEndpoint, optionalHttpUrl, singleLineToken } from '../../lib/settingsDraft'
import { useApp } from '../../store'
import { Advanced, Button, Group, Row, Section, Segmented, Select } from '../../components/ui'
import { SectionBody, TextSetting, useSaveSettings } from './fields'

export function NetworkSection(): React.JSX.Element {
  const settings = useApp((state) => state.settings)!
  const env = useApp((state) => state.env)
  const save = useSaveSettings()
  const { remoteHosts } = featureVisibility(settings)
  const [hosts, setHosts] = useState<ManagedHost[]>([])

  useEffect(() => {
    if (!remoteHosts) return
    let canceled = false
    void call<ManagedHost[]>(Ipc.hostsList)
      .then((list) => {
        if (!canceled) setHosts(list.filter((host) => host.kind === 'ssh'))
      })
      .catch(() => undefined)
    return () => {
      canceled = true
    }
  }, [remoteHosts])

  const selected = env?.network.selected

  return (
    <SectionBody>
      <Section title="Hugging Face">
        <Group>
          <TextSetting<string | null>
            title="访问令牌（Token）"
            description={
              settings.hasHfToken
                ? '已保存。部分模型需要登录 Hugging Face 并同意许可后才能下载。留空不会改动已保存的令牌。'
                : '部分模型需要登录 Hugging Face 并同意许可后才能下载。令牌只保存在本机，并加密存放。'
            }
            type="password"
            value={null}
            placeholder={settings.hasHfToken ? '已保存' : 'hf_…'}
            validate={singleLineToken}
            clearOnSave
            onSave={(hfToken) => (hfToken ? save({ hfToken }, '令牌已保存') : Promise.resolve(true))}
            trailing={
              settings.hasHfToken ? (
                <Button tone="ghost" onClick={() => void save({ hfToken: null }, '令牌已清除')}>
                  清除
                </Button>
              ) : null
            }
          />
        </Group>
      </Section>

      <Group>
        <Advanced summary="下载方式、镜像、端点、并发、备用主机、GitHub 令牌">
          <div className="flex flex-col gap-0.5">
            <Row title="下载方式" description="自动会测速并选择更快的线路，镜像失败时改用直连。">
              <Segmented<Settings['networkMode']>
                label="下载方式"
                value={settings.networkMode}
                onChange={(networkMode) => void save({ networkMode })}
                options={[
                  { value: 'auto', label: '自动' },
                  { value: 'direct', label: '直连' },
                  { value: 'mirror', label: '镜像' },
                ]}
              />
            </Row>
            {selected ? (
              <Row
                title="当前使用"
                description={<span className="font-mono">{`Git ${selected.git ?? '直连'} · HF ${selected.hf ?? '直连'}`}</span>}
              />
            ) : null}
            <TextSetting
              title="Git 镜像"
              description="安装引擎和训练器时使用的 Git 地址前缀。留空时自动选择。"
              value={settings.gitMirror}
              placeholder="https://ghproxy.net/"
              validate={optionalHttpUrl}
              mono
              onSave={(gitMirror) => save({ gitMirror })}
            />
            <TextSetting
              title="Hugging Face 端点"
              description="下载模型时使用的地址。留空时使用官方地址。"
              value={settings.hfEndpoint}
              placeholder="https://hf-mirror.com"
              validate={optionalHfEndpoint}
              mono
              onSave={(hfEndpoint) => save({ hfEndpoint })}
            />
            <TextSetting<number>
              inline
              title="同时下载的文件数"
              description="1 到 16。网络不稳定时调低一些。"
              value={settings.modelDownloadConcurrency ?? 4}
              validate={integerInRange(1, 16)}
              parse={Number}
              type="number"
              inputClassName="w-24"
              onSave={(modelDownloadConcurrency) => save({ modelDownloadConcurrency })}
            />
            {remoteHosts ? (
              <Row title="查询失败时改用远程主机" description="本机查不到模型文件列表时，借用一台远程主机的网络查询。">
                <Select
                  aria-label="查询失败时改用远程主机"
                  className="w-48"
                  value={settings.hfQueryHostId ?? ''}
                  onValueChange={(value) => void save({ hfQueryHostId: value || null })}
                  options={[
                    { value: '', label: '自动选择' },
                    { value: 'local', label: '只用本机' },
                    ...hosts.map((host) => ({ value: host.id, label: host.name })),
                  ]}
                />
              </Row>
            ) : null}
            <TextSetting<string | null>
              title="GitHub 令牌"
              description="正式版引擎不需要。安装开发版引擎，或 GitHub 限制访问次数时需要。只用于本机访问 GitHub。"
              type="password"
              value={settings.githubToken}
              placeholder="github_pat_…"
              validate={singleLineToken}
              mono
              onSave={(githubToken) => save({ githubToken }, githubToken ? 'GitHub 令牌已保存' : 'GitHub 令牌已清除')}
            />
          </div>
        </Advanced>
      </Group>
    </SectionBody>
  )
}
