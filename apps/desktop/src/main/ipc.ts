import { app, clipboard, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { ZodError, type ZodType } from 'zod'
import { Events, Ipc } from '@shared/channels'
import { schemas } from '@shared/schemas'
import type { IpcResult } from '@shared/types'
import { emit } from './lib/events'
import { ensureDirs, paths } from './lib/paths'
import { scanEnvironment } from './services/env'
import { getPythonInstallState, installManagedPython } from './services/managedPython'
import { cancelDownload, getCatalog, deleteModel, importModelFolder, listDownloads, pauseDownload, startDownload, installBundle } from './services/models'
import { galleryDetail, listGallery, revealInFolder } from './services/gallery'
import { cancelJob, getJob, getJobLogs, inputJob, listJobs } from './services/supervisor'
import { clearDiagnostics, dismissDiagnostic, listDiagnostics } from './services/diagnostics'
import { getSettings, updateSettings } from './services/settings'
import { checkUpdates, dismissAnnouncement } from './services/updates'
import { cancelUpdateDownload, downloadUpdate } from './services/updateDownload'
import {
  cancelMossInferDownload,
  downloadMossInfer,
  getMossInferDownloadState,
  listMossInferReleases,
} from './services/mossInferDownload'
import { getWebAccessInfo, startBackend, stopBackend } from './services/backend'
import { chat, listConversations, listProviders, removeConversation, removeProvider, saveProvider } from './services/ai'
import { gbcStatus, installGbcEnv, listGbcImages, runGbc } from './services/gbc'
import { nativeImage } from 'electron'
import { createGbcVersion, listGbcBranches, listGbcCommits, listGbcVersions, removeGbcVersion } from './services/gbcGit'
import { closeSshTerminal, inputSshTerminal, listSshTerminals, openSshTerminal } from './services/sshSessions'
import {
  localEngineInfo,
  localEngineVersions,
  probeLocalEngine,
  remoteEngineInfo,
  removeLocalEngineVersion,
  selectLocalEngineDirectory,
  selectLocalEngineVersion,
} from './services/engines'
import { detectSystemCuda } from './services/systemCuda'
import { installMossInferCudaLibs } from './services/cudaWheels'
import { prepareRemoteDefaultModel, prepareRemoteModel, scanRemoteModels } from './services/remoteModels'
import { installRemoteEngine } from './services/remoteEngineInstall'
import { inspectRemoteResource, removeRemoteResource } from './services/remoteResources'
import { getTrainingHost, updateTrainingHostModelPath } from './services/trainingHosts'
import { pushTestNotification } from './services/desktopNotifications'
import { isInside } from './lib/paths'
import { openWindow } from './windows'
import { listDevices } from './services/devices'
import { getOnboardingStatus } from './services/onboarding'
import {
  createTrainerVersion,
  ensureTrainerRuntime,
  installTrainerRuntime,
  listAllTrainerVersions,
  listTrainerVersions,
  removeTrainerVersion,
  trainerDoctor,
  trainerMirrorInfo,
  startTrainerRun,
} from './services/trainers'
import { listTrainerBranches, listTrainerCommits } from './services/trainerGit'
import { getBackendInfo } from './services/backend'
import { deleteProject, getProject, listProjects, saveProject } from './services/projects'
import { listLaunchRows, removeLaunchRow, upsertLaunchRow } from './services/launchQueue'
import {
  listManagedHosts,
  listTrainingHosts,
  removeTrainingHost,
  saveTrainingHost,
  testManagedHost,
  testTrainingHost,
  updateTrainingHostPaths,
} from './services/trainingHosts'
import {
  remoteBranches,
  remoteCommits,
  remoteCreateVersion,
  remoteDoctor,
  remoteInstallRuntime,
  remoteRemoveVersion,
  remoteVersion,
  remoteVersions,
} from './services/remoteTrainer'

function toResult<T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  return Promise.resolve()
    .then(fn)
    .then((data) => ({ ok: true as const, data }))
    .catch((error: unknown) => ({
      ok: false as const,
      error: {
        code: error instanceof ZodError ? 'BAD_REQUEST' : 'INTERNAL',
        message:
          error instanceof ZodError
            ? error.issues[0]?.message ?? '参数不合法'
            : error instanceof Error
              ? error.message
              : String(error),
      },
    }))
}

function handle<T>(channel: string, schema: ZodType | null, fn: (input: any) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, payload: unknown) =>
    toResult(async () => {
      const input = schema ? schema.parse(payload ?? {}) : payload
      return await fn(input)
    }),
  )
}

export function registerIpc(): void {
  handle(Ipc.appInfo, null, () => ({
    name: 'MossStudio',
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    platform: process.platform,
    arch: process.arch,
    dataPath: paths.root(),
    modelsPath: paths.models(getSettings().modelsRoot),
    acrylic: false,
    backend: getBackendInfo(),
  }))

  handle(Ipc.backendInfo, null, () => getBackendInfo())

  handle(Ipc.aiProvidersList, null, () => listProviders())

  handle(Ipc.aiProviderSave, schemas.aiProviderSave, (input) => saveProvider(input))

  handle(Ipc.aiProviderRemove, schemas.projectId, ({ id }) => {
    removeProvider(id)
    return true
  })

  handle(Ipc.aiConversations, null, () => listConversations())

  handle(Ipc.aiConversationRemove, schemas.projectId, ({ id }) => {
    removeConversation(id)
    return true
  })

  handle(Ipc.aiChat, schemas.aiChat, (input) => chat(input))

  handle(Ipc.gbcStatus, schemas.gbcStatusQuery, ({ versionId }) => gbcStatus(versionId))

  handle(Ipc.gbcDoctor, schemas.gbcStatusQuery, ({ versionId }) => gbcStatus(versionId))

  handle(Ipc.gbcInstallEnv, schemas.gbcInstallEnv, ({ versionId }) => installGbcEnv(versionId))

  handle(Ipc.gbcListImages, schemas.gbcListImages, ({ folder }) => listGbcImages(folder))

  handle(Ipc.gbcThumbnails, schemas.gbcThumbnails, ({ paths, width }) => {
    return paths.map((path: string) => {
      try {
        const image = nativeImage.createFromPath(path)
        if (image.isEmpty()) return { path, dataUrl: '' }
        const size = image.getSize()
        const scale = Math.min(1, width / size.width)
        const resized = scale < 1 ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), quality: 'good' }) : image
        return { path, dataUrl: resized.toDataURL() }
      } catch {
        return { path, dataUrl: '' }
      }
    })
  })

  handle(Ipc.gbcRun, schemas.gbcRun, (input) => runGbc(input))

  handle(Ipc.gbcBranches, null, () => listGbcBranches(getSettings()))

  handle(Ipc.gbcCommits, schemas.gbcCommits, ({ branch, limit }) => listGbcCommits(getSettings(), branch, limit))

  handle(Ipc.gbcVersions, null, () => listGbcVersions(getSettings()))

  handle(Ipc.gbcVersionCreate, schemas.gbcVersionCreate, ({ branch, commit, name }) => createGbcVersion(getSettings(), branch, commit, name))

  handle(Ipc.gbcVersionRemove, schemas.gbcVersionRemove, async ({ id }) => { await removeGbcVersion(getSettings(), id); return true })

  handle(Ipc.webAccessInfo, null, () => getWebAccessInfo())

  handle(Ipc.webAccessRestart, null, async () => {
    stopBackend()
    await startBackend()
    return getWebAccessInfo()
  })

  handle(Ipc.windowOpen, schemas.windowOpen, ({ kind, route }) => {
    openWindow(kind, route)
    return true
  })

  handle(Ipc.copyText, schemas.copyText, ({ text }) => {
    clipboard.writeText(text)
    return true
  })

  handle(Ipc.devicesList, null, () => listDevices(getSettings()))

  handle(Ipc.hostsList, null, () => listManagedHosts(getSettings()))

  handle(Ipc.hostsSave, schemas.hostSave, (input) => {
    const saved = saveTrainingHost(input)
    const managed = listManagedHosts(getSettings()).find((host) => host.id === saved.id) ?? saved
    emit(Events.hostsChanged, { id: saved.id })
    return managed
  })

  handle(Ipc.hostsRemove, schemas.hostId, ({ id }) => {
    removeTrainingHost(id)
    emit(Events.hostsChanged, { id })
    return true
  })

  handle(Ipc.remoteResourceInspect, schemas.remoteResourceInspect, async ({ hostId, kind, path }) => {
    const host = getTrainingHost(getSettings(), hostId)
    if (!host) throw new Error('主机不存在')
    return inspectRemoteResource(host, kind, path)
  })

  handle(Ipc.remoteResourceRemove, schemas.remoteResourceRemove, async ({ hostId, path }) => {
    const host = getTrainingHost(getSettings(), hostId)
    if (!host) throw new Error('主机不存在')
    await removeRemoteResource(host, path)
    emit(Events.hostsChanged, { id: hostId })
    return true
  })

  handle(Ipc.hostsUpdatePaths, schemas.hostUpdatePaths, ({ id, ...patch }) => {
    updateTrainingHostPaths(id, patch)
    emit(Events.hostsChanged, { id })
    return listManagedHosts(getSettings()).find((host) => host.id === id) ?? null
  })

  handle(Ipc.hostsTest, schemas.hostId, async ({ id }) => {
    const host = await testManagedHost(getSettings(), id)
    emit(Events.hostsChanged, { id })
    return host
  })

  handle(Ipc.launchQueueList, null, () => listLaunchRows())

  handle(Ipc.launchQueueUpsert, schemas.launchRow, (row) => upsertLaunchRow(row))

  handle(Ipc.launchQueueRemove, schemas.launchRowId, ({ id }) => {
    removeLaunchRow(id)
    return true
  })

  handle(Ipc.onboardingStatus, schemas.onboardingStatus, (input) => getOnboardingStatus(getSettings(), input?.hostId))
  handle(Ipc.pythonInstall, null, () => installManagedPython())
  handle(Ipc.pythonInstallState, null, () => getPythonInstallState())

  handle(Ipc.trainerMirror, null, () => trainerMirrorInfo(getSettings()))

  handle(Ipc.trainerHosts, null, () => listTrainingHosts(getSettings()))

  handle(Ipc.trainerHostSave, schemas.trainerHostSave, (input) => saveTrainingHost(input))

  handle(Ipc.trainerHostRemove, schemas.trainerHostRemove, ({ id }) => {
    removeTrainingHost(id)
    return true
  })

  handle(Ipc.trainerHostTest, schemas.trainerHostTest, ({ id }) => testTrainingHost(getSettings(), id))

  handle(Ipc.trainerRemoteBranches, schemas.trainerRemoteHost, ({ hostId }) => remoteBranches(getSettings(), hostId))

  handle(Ipc.trainerRemoteCommits, schemas.trainerRemoteCommits, ({ hostId, branch, limit }) =>
    remoteCommits(getSettings(), hostId, branch, limit),
  )

  handle(Ipc.trainerRemoteVersions, schemas.trainerRemoteHost, ({ hostId }) => remoteVersions(getSettings(), hostId))

  handle(Ipc.trainerRemoteCreate, schemas.trainerRemoteCreate, ({ hostId, ...input }) =>
    remoteCreateVersion(getSettings(), hostId, input),
  )

  handle(Ipc.trainerRemoteInstall, schemas.trainerRemoteVersion, ({ hostId, versionId }) =>
    remoteInstallRuntime(getSettings(), remoteVersion(getSettings(), hostId, versionId)),
  )

  handle(Ipc.trainerRemoteDoctor, schemas.trainerRemoteVersion, ({ hostId, versionId }) =>
    remoteDoctor(getSettings(), remoteVersion(getSettings(), hostId, versionId)),
  )

  handle(Ipc.trainerRemoteRemove, schemas.trainerRemoteVersion, async ({ hostId, versionId }) => {
    await remoteRemoveVersion(getSettings(), remoteVersion(getSettings(), hostId, versionId))
    return true
  })

  handle(Ipc.trainerBranches, null, () => listTrainerBranches(getSettings()))

  handle(Ipc.trainerCommits, schemas.trainerCommits, ({ branch, limit }) =>
    listTrainerCommits(getSettings(), branch, limit),
  )

  handle(Ipc.trainerVersions, null, () => listTrainerVersions(getSettings()))

  handle(Ipc.trainerAllVersions, null, () => listAllTrainerVersions(getSettings()))

  handle(Ipc.trainerCreate, schemas.trainerCreate, (input) => createTrainerVersion(getSettings(), input))

  handle(Ipc.trainerRemove, schemas.trainerId, async ({ id }) => {
    await removeTrainerVersion(getSettings(), id)
    return true
  })

  handle(Ipc.trainerInstall, schemas.trainerId, ({ id }) => installTrainerRuntime(getSettings(), id))

  handle(Ipc.trainerDoctor, schemas.trainerId, ({ id }) => trainerDoctor(getSettings(), id))

  handle(Ipc.trainerRun, schemas.trainerRun, (input) => startTrainerRun(getSettings(), input))

  handle(Ipc.settingsGet, null, () => getSettings())

  handle(Ipc.settingsUpdate, schemas.settingsUpdate, async (patch) => {
    const before = getSettings()
    const settings = updateSettings(patch)
    ensureDirs(settings.modelsRoot)
    if (before.lanWebEnabled !== settings.lanWebEnabled || before.lanWebPort !== settings.lanWebPort) {
      stopBackend()
      await startBackend()
    }
    emit(Events.settingsChanged, settings)
    return settings
  })

  handle(Ipc.envScan, null, () => scanEnvironment(getSettings(), (event) => emit(Events.envProgress, event)))

  handle(Ipc.updatesCheck, null, () => checkUpdates(getSettings()))

  handle(Ipc.updatesDownload, schemas.updatesDownload, ({ version, installer }) =>
    downloadUpdate(version, installer),
  )

  handle(Ipc.updatesCancel, schemas.updatesCancel, ({ version }) => cancelUpdateDownload(version))

  handle(Ipc.mossInferDownload, schemas.mossInferDownload, ({ channel, flavour, variant, cudaWheels, releaseTag }) =>
    downloadMossInfer(channel, flavour, variant, cudaWheels, releaseTag),
  )

  handle(Ipc.engineStatus, null, () => localEngineInfo())

  handle(Ipc.engineVersions, null, () => localEngineVersions())

  handle(Ipc.engineVersionSelect, schemas.engineVersionId, ({ id }) => selectLocalEngineVersion(id))

  handle(Ipc.engineVersionRemove, schemas.engineVersionId, ({ id }) => removeLocalEngineVersion(id))

  handle(Ipc.engineSelectDirectory, schemas.engineSelectDirectory, ({ path }) => selectLocalEngineDirectory(path))

  handle(Ipc.engineProbe, null, () => probeLocalEngine())

  handle(Ipc.engineRemoteStatus, schemas.engineRemoteStatus, ({ hostId }) => remoteEngineInfo(hostId))

  handle(Ipc.engineSystemCuda, schemas.engineSystemCuda, () => detectSystemCuda())

  handle(Ipc.sshTerminalOpen, schemas.sshTerminalOpen, ({ hostId }) => openSshTerminal(hostId))

  handle(Ipc.sshTerminalList, null, () => listSshTerminals())

  handle(Ipc.sshTerminalInput, schemas.sshTerminalInput, ({ id, data }) => { inputSshTerminal(id, data); return true })

  handle(Ipc.sshTerminalClose, schemas.sshTerminalClose, ({ id }) => { closeSshTerminal(id); return true })

  handle(Ipc.mossInferCudaLibs, schemas.mossInferCudaLibs, () => installMossInferCudaLibs())

  handle(Ipc.engineInstallRemote, schemas.engineInstallRemote, async ({ hostId }) => {
    const host = getTrainingHost(getSettings(), hostId)
    if (!host) throw new Error('主机不存在')
    return installRemoteEngine(host, (phase, message, percent) => emit(Events.engineRemoteProgress, { hostId, phase, message, percent }))
  })

  handle(Ipc.enginePrepareRemoteModel, schemas.enginePrepareRemoteModel, async ({ hostId, repo }) => {
    const host = getTrainingHost(getSettings(), hostId)
    if (!host) throw new Error('主机不存在')
    const result = await prepareRemoteDefaultModel(host, repo)
    updateTrainingHostModelPath(hostId, result.path)
    emit(Events.hostsChanged, { id: hostId })
    return result
  })

  handle(Ipc.mossInferDownloadState, null, () => getMossInferDownloadState())

  handle(Ipc.mossInferReleases, null, () => listMossInferReleases())

  handle(Ipc.mossInferDownloadCancel, null, () => cancelMossInferDownload())

  handle(Ipc.notificationTest, null, () => pushTestNotification())

  handle(Ipc.announcementsDismiss, schemas.announcementsDismiss, ({ id }) => {
    dismissAnnouncement(id)
    return true
  })

  handle(Ipc.projectsList, null, () => listProjects())

  handle(Ipc.projectGet, schemas.projectId, ({ id }) => getProject(id))

  handle(Ipc.projectSave, schemas.projectSave, (input) => saveProject(input))

  handle(Ipc.projectDelete, schemas.projectId, ({ id }) => {
    deleteProject(id)
    return true
  })

  handle(Ipc.modelsCatalog, null, () => getCatalog(getSettings(), true))

  handle(Ipc.modelsRemoteInventory, schemas.modelsRemoteInventory, async ({ hostId, modelsRoot }) => {
    const host = getTrainingHost(getSettings(), hostId)
    if (!host) throw new Error('主机不存在')
    return scanRemoteModels(host, await getCatalog(getSettings(), true), modelsRoot)
  })

  handle(Ipc.modelsRemoteDownload, schemas.modelsRemoteDownload, async ({ hostId, modelId }) => {
    const host = getTrainingHost(getSettings(), hostId)
    if (!host) throw new Error('主机不存在')
    const catalog = await getCatalog(getSettings(), true)
    const model = catalog.models.find((entry) => entry.id === modelId) ?? catalog.adapters.find((entry) => entry.id === modelId)
    if (!model) throw new Error('模型不存在')
    const result = await prepareRemoteModel(host, model)
    emit(Events.hostsChanged, { id: hostId })
    return result
  })

  handle(Ipc.modelsImportFolder, null, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择模型文件夹',
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true, added: 0, duplicates: 0 }
    const imported = await importModelFolder(result.filePaths[0], getSettings())
    return { canceled: false, ...imported }
  })

  handle(Ipc.modelsInstalled, null, async () => {
    const catalog = await getCatalog(getSettings())
    return catalog.models.filter((model) => model.installed)
  })

  handle(Ipc.modelBundleInstall, schemas.modelBundle, ({ id }) => installBundle(id, getSettings()))

  handle(Ipc.modelDownload, schemas.download, ({ kind, id }) =>
    startDownload(kind, id, getSettings()),
  )

  handle(Ipc.modelPause, schemas.modelPause, ({ taskId }) => {
    pauseDownload(taskId)
    return true
  })

  handle(Ipc.modelCancel, schemas.modelPause, async ({ taskId }) => {
    await cancelDownload(taskId)
    return true
  })

  handle(Ipc.modelDelete, schemas.downloadDelete, async ({ kind, id }) => {
    await deleteModel(kind, id, getSettings())
    return true
  })

  handle(Ipc.downloadsList, null, () => listDownloads())

  handle(Ipc.jobCancel, schemas.jobId, ({ id }) => cancelJob(id))

  handle(Ipc.jobList, null, () => listJobs())

  handle(Ipc.jobGet, schemas.jobId, ({ id }) => getJob(id))

  handle(Ipc.jobLogs, schemas.jobId, ({ id }) => getJobLogs(id))

  handle(Ipc.jobInput, schemas.jobInput, ({ id, text }) => {
    inputJob(id, text)
    return true
  })

  handle(Ipc.jobOpenLog, schemas.jobId, async ({ id }) => {
    const job = await getJob(id)
    if (job?.logPath) shell.showItemInFolder(job.logPath)
    return true
  })

  handle(Ipc.diagnosticsList, null, () => listDiagnostics())

  handle(Ipc.diagnosticsDismiss, schemas.diagnosticsDismiss, ({ id }) => {
    dismissDiagnostic(id)
    return true
  })

  handle(Ipc.diagnosticsClear, null, () => {
    clearDiagnostics()
    return true
  })

  handle(Ipc.galleryList, schemas.galleryList, (input) => listGallery(getSettings(), input))

  handle(Ipc.galleryItem, schemas.galleryItem, ({ path }) => galleryDetail(path))

  handle(Ipc.galleryReveal, schemas.galleryReveal, ({ path }) => revealInFolder(path))

  handle(Ipc.pickDialog, schemas.pickDialog, async ({ kind, title }) => {
    const result = await dialog.showOpenDialog({
      title,
      properties: kind === 'folder' ? ['openDirectory', 'createDirectory'] : ['openFile'],
      filters:
        kind === 'image'
          ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
          : undefined,
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle(Ipc.pickImages, schemas.pickImages, async ({ title }) => {
    const result = await dialog.showOpenDialog({
      title,
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
    })
    return result.canceled ? [] : result.filePaths
  })

  handle(Ipc.openPath, schemas.openPath, async ({ path }) => {
    const allowed = [paths.root(), paths.models(getSettings().modelsRoot)]
    if (!allowed.some((base) => isInside(base, path))) throw new Error('路径不在允许范围内')
    mkdirSync(path, { recursive: true })
    if (!statSync(path).isDirectory()) throw new Error('目标路径不是目录')
    const error = await shell.openPath(path)
    // ShellExecuteW can fail here even for a directory the app can read (it then
    // shows its own "Windows cannot access..." dialog). Fall back to launching
    // Explorer directly so the user still gets the folder open.
    if (error) {
      const child = spawn('explorer.exe', [path], { detached: true, stdio: 'ignore' })
      child.on('error', () => undefined)
      child.unref()
    }
    return true
  })

  handle(Ipc.openExternal, schemas.openExternal, async ({ url }) => {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^\[|\]$/g, '')
    const privateHttp =
      parsed.protocol === 'http:' &&
      (host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host))
    if (parsed.protocol !== 'https:' && !privateHttp) {
      throw new Error('只允许打开 https 或本机/局域网 http 链接')
    }
    await shell.openExternal(url)
    return true
  })
}
