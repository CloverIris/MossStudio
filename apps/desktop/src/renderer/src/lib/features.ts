import type { Settings } from '@shared/types'

/** Optional features. Each is off by default and turned on in 设置 › 功能. */
export type FeatureKey = 'remoteHostsEnabled' | 'trainingEnabled' | 'gbcEnabled' | 'lanWebEnabled'

export interface FeatureInfo {
  key: FeatureKey
  label: string
  description: string
}

export const FEATURES: FeatureInfo[] = [
  {
    key: 'remoteHostsEnabled',
    label: '远程主机',
    description: '把生成和训练放到一台通过 SSH 连接的 NVIDIA 电脑上运行。',
  },
  {
    key: 'trainingEnabled',
    label: '训练',
    description: '用自己的图片训练 LoRA，训练好的 LoRA 可以直接在创作中使用。',
  },
  {
    key: 'gbcEnabled',
    label: '看图拆区域',
    description: '把一张图拆成带描述的区域，照它的布局再画一张。',
  },
  {
    key: 'lanWebEnabled',
    label: '局域网访问',
    description: '同一网络下的手机或电脑可以用浏览器打开创作页。',
  },
]

export function featureEnabled(settings: Pick<Settings, FeatureKey> | null | undefined, key: FeatureKey): boolean {
  return Boolean(settings?.[key])
}

/** Which optional areas of the app should appear at all. */
export function featureVisibility(settings: Pick<Settings, FeatureKey> | null | undefined): {
  remoteHosts: boolean
  training: boolean
  gbc: boolean
  lan: boolean
} {
  return {
    remoteHosts: featureEnabled(settings, 'remoteHostsEnabled'),
    training: featureEnabled(settings, 'trainingEnabled'),
    gbc: featureEnabled(settings, 'gbcEnabled'),
    lan: featureEnabled(settings, 'lanWebEnabled'),
  }
}
