import type { ManagedHost, SshAuthMethod } from '@shared/types'
import { integerInRange, optionalHfEndpoint, optionalProxyUrl, requiredText } from '../../lib/settingsDraft'

/** What the 添加 SSH 主机 dialog edits. Strings throughout, as typed. */
export interface HostForm {
  id?: string
  name: string
  host: string
  user: string
  port: string
  authMethod: SshAuthMethod
  identityFile: string
  password: string
  hasPassword: boolean
  trainerRoot: string
  engineRoot: string
  outputRoot: string
  modelsRoot: string
  downloadProxy: string
  hfEndpoint: string
  downloadConcurrency: string
  hfToken: string
  hasHfToken: boolean
  clearHfToken: boolean
}

export const REMOTE_DEFAULT_PATHS = {
  trainerRoot: '~/.mossstudio/trainer',
  engineRoot: '~/.mossstudio/engine',
  outputRoot: '~/.mossstudio/outputs',
  modelsRoot: '~/.mossstudio/models',
} as const

export function emptyHostForm(): HostForm {
  return {
    name: '',
    host: '',
    user: '',
    port: '22',
    authMethod: 'identityFile',
    identityFile: '',
    password: '',
    hasPassword: false,
    ...REMOTE_DEFAULT_PATHS,
    downloadProxy: '',
    hfEndpoint: '',
    downloadConcurrency: '',
    hfToken: '',
    hasHfToken: false,
    clearHfToken: false,
  }
}

export function hostFormFrom(host: ManagedHost): HostForm {
  return {
    id: host.id,
    name: host.name,
    host: host.host ?? '',
    user: host.user ?? '',
    port: String(host.port ?? 22),
    authMethod: host.authMethod ?? 'identityFile',
    identityFile: host.identityFile ?? '',
    password: '',
    hasPassword: host.hasPassword ?? false,
    trainerRoot: host.trainerRoot || REMOTE_DEFAULT_PATHS.trainerRoot,
    engineRoot: host.engineRoot ?? REMOTE_DEFAULT_PATHS.engineRoot,
    outputRoot: host.outputRoot ?? REMOTE_DEFAULT_PATHS.outputRoot,
    modelsRoot: host.modelsRoot ?? REMOTE_DEFAULT_PATHS.modelsRoot,
    downloadProxy: host.downloadProxy ?? '',
    hfEndpoint: host.hfEndpoint ?? '',
    downloadConcurrency: host.downloadConcurrency ? String(host.downloadConcurrency) : '',
    hfToken: '',
    hasHfToken: host.hasHfToken ?? false,
    clearHfToken: false,
  }
}

export type HostFormErrors = Partial<Record<keyof HostForm, string>>

/** Field-by-field problems, shown under each field. Empty means the form can be saved. */
export function validateHostForm(form: HostForm): HostFormErrors {
  const errors: HostFormErrors = {}
  const host = requiredText('地址')(form.host)
  if (host) errors.host = host
  else if (/\s/.test(form.host.trim())) errors.host = '地址不能包含空格'
  const user = requiredText('用户名')(form.user)
  if (user) errors.user = user
  const port = integerInRange(1, 65535)(form.port)
  if (port) errors.port = port
  if (form.authMethod === 'password' && !form.password && !form.hasPassword) errors.password = '请输入 SSH 密码'
  if (/[\r\n\0]/.test(form.password)) errors.password = '密码不能包含换行'
  const trainerRoot = requiredText('训练器目录')(form.trainerRoot)
  if (trainerRoot) errors.trainerRoot = trainerRoot
  const proxy = optionalProxyUrl(form.downloadProxy)
  if (proxy) errors.downloadProxy = proxy
  const endpoint = optionalHfEndpoint(form.hfEndpoint)
  if (endpoint) errors.hfEndpoint = endpoint
  const concurrency = integerInRange(1, 16, { optional: true })(form.downloadConcurrency)
  if (concurrency) errors.downloadConcurrency = concurrency
  return errors
}

/** The `Ipc.hostsSave` payload. Paths the save call does not take go through `hostPathsPatch`. */
export function hostSavePayload(form: HostForm): Record<string, unknown> {
  const host = form.host.trim()
  return {
    id: form.id,
    name: form.name.trim() || host,
    host,
    user: form.user.trim(),
    port: Number(form.port) || 22,
    authMethod: form.authMethod,
    identityFile: form.authMethod === 'identityFile' ? form.identityFile.trim() || undefined : undefined,
    password: form.authMethod === 'password' ? form.password || undefined : undefined,
    trainerRoot: form.trainerRoot.trim(),
    modelsRoot: form.modelsRoot.trim() || undefined,
    downloadProxy: form.downloadProxy.trim(),
    hfEndpoint: form.hfEndpoint.trim(),
    downloadConcurrency: form.downloadConcurrency.trim() ? Number(form.downloadConcurrency) : null,
    hfToken: form.hfToken.trim() || undefined,
    clearHfToken: form.clearHfToken,
  }
}

/** Engine and output folders are saved separately (`Ipc.hostsUpdatePaths`). */
export function hostPathsPatch(id: string, form: HostForm): { id: string; engineRoot?: string; outputRoot?: string } {
  return {
    id,
    engineRoot: form.engineRoot.trim() || undefined,
    outputRoot: form.outputRoot.trim() || undefined,
  }
}
