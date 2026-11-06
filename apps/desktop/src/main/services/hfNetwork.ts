import type { Settings } from '@shared/types'
import { getHfToken } from './hfCredentials'
import { listTrainingHosts } from './trainingHosts'
import { queryRemoteHf } from './remoteDownloads'

export async function fetchHf(url: string, endpoint: string, settings: Settings, signal?: AbortSignal): Promise<Response> {
  try {
    const token = getHfToken()
    const response = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`HF HTTP ${response.status}`)
    return response
  } catch (localError) {
    signal?.throwIfAborted()
    if (settings.hfQueryHostId === 'local') throw localError
    const hosts = listTrainingHosts(settings)
      .filter((host) => host.kind === 'ssh' && (!settings.hfQueryHostId || host.id === settings.hfQueryHostId))
      .sort((left, right) => Number(right.status === 'ok') - Number(left.status === 'ok'))
    if (!hosts.length) throw localError
    let remoteError: unknown
    for (const host of hosts) {
      signal?.throwIfAborted()
      try {
        const result = await queryRemoteHf(host.id, url, endpoint)
        signal?.throwIfAborted()
        return new Response(result.body, { status: 200, headers: result.headers })
      } catch (error) {
        remoteError = error
      }
    }
    throw new Error(
      `本机 HF 查询失败（${localError instanceof Error ? localError.message : String(localError)}）；远端查询失败（${remoteError instanceof Error ? remoteError.message : String(remoteError)}）`,
    )
  }
}
