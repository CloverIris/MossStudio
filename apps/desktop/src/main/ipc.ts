import { app, clipboard, dialog, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { ZodError, type ZodType } from 'zod'
import { Events, Ipc } from '@shared/channels'
import { schemas } from '@shared/schemas'
import { STUDIO_TOOLS } from '@shared/mcp'
import type { AiToolCall, AiToolResult } from '@shared/ai'
import type { IpcResult } from '@shared/types'
import { emit } from './lib/events'
import { ensureDirs, paths } from './lib/paths'
import { openDirectoryInFileManager, revealInFileManager } from './lib/fileManager'
import { scanEnvironment } from './services/env'
import { getPythonInstallState, installManagedPython } from './services/managedPython'
import {
  cancelDownload,
  cleanupEmptyModelDirs,
  getCatalog,
  deleteModel,
  importAdapterFile,
  importModelFolder,
  invalidateCatalog,
  listDownloads,
  pauseDownload,
  registerScannedModels,
  scanModels,
  startDownload,
  installBundle,
} from './services/models'
import { galleryDetail, listGallery, recordJobOutputs, revealInFolder, trashGalleryItem } from './services/gallery'
import { activeJobInputPaths, cancelJob, getJob, getJobLogs, inputJob, listJobs, onJobCompleted } from './services/supervisor'
import { clearDiagnostics, dismissDiagnostic, listDiagnostics } from './services/diagnostics'
import { getSettings, updateSettings } from './services/settings'
import { updaterApi } from './update'
import { clearEngineAutoUpdateHold, recordManualEngineInstall, startEngineAutoUpdate } from './services/engineAutoUpdate'
import { cancelMossInferDownload, getMossInferDownloadState, listMossInferReleases } from './services/mossInferDownload'
import { getWebAccessInfo, startBackend, stopBackend } from './services/backend'
import { chat, listConversations, listProviders, removeConversation, removeProvider, renameConversation, saveProvider } from './services/ai'
import { gbcStatus, installGbcEnv, listGbcImages, runGbc } from './services/gbc'
import { nativeImage } from 'electron'
import { createGbcVersion, listGbcBranches, listGbcCommits, listGbcVersions, removeGbcVersion } from './services/gbcGit'
import { closeSshTerminal, inputSshTerminal, listSshTerminals, openSshTerminal } from './services/sshSessions'
import {
  localEngineVersions,
  probeLocalEngine,
  remoteEngineInfo,
  removeLocalEngineVersion,
  selectLocalEngineDirectory,
  selectLocalEngineVersion,
} from './services/engines'
import { detectSystemCuda } from './services/systemCuda'
import { engineReadiness, invalidateEngineReadiness } from './services/engineReadiness'
import { installMossInferCudaLibs } from './services/cudaWheels'
import { saveHfToken } from './services/hfCredentials'
import { controlRemoteDownload, listRemoteDownloads, refreshRemoteDownloads } from './services/remoteDownloads'
import { deleteRemoteModels, prepareRemoteDefaultModel, prepareRemoteModel, scanRemoteModels } from './services/remoteModels'
import { installRemoteEngine } from './services/remoteEngineInstall'
import { getEnginePlan, installEnginePlan, packagesFromIds, startupEnginePlan } from './services/enginePlan'
import { releaseAfterSettingsChange } from './services/engineInstalls'
import { inspectRemoteResource, removeRemoteResource } from './services/remoteResources'
import { getTrainingHost } from './services/trainingHosts'
import { pushTestNotification } from './services/desktopNotifications'
import { isInside } from './lib/paths'
import { errorCode } from './lib/codedError'
import { getEngineFeatures } from './services/engineFeatures'
import { importImageBytes, importImageFile, pruneProjectMasks, saveMask } from './services/studioAssets'
import { addControlAdapter, listControlAdapters, removeControlAdapter } from './services/controlAdapters'
import { applyThemeSource, openWindow } from './windows'
import { getGpuInventory, listDevices, refreshGpuInventory } from './services/devices'
import { getOnboardingStatus } from './services/onboarding'
import {
  createTrainerVersion,
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
        code: error instanceof ZodError ? 'BAD_REQUEST' : (errorCode(error) ?? 'INTERNAL'),
        message:
          error instanceof ZodError ? (error.issues[0]?.message ?? '参数不合法') : error instanceof Error ? error.message : String(error),
      },
    }))
}

function handle<T>(channel: string, schema: ZodType | null, fn: (input: any, event: Electron.IpcMainInvokeEvent) => Promise<T> | T): void {
  ipcMain.handle(channel, async (event, payload: unknown) =>
    toResult(async () => {
      const input = schema ? schema.parse(payload ?? {}) : payload
      return await fn(input, event)
    }),
  )
}

/** Tool calls are executed by the renderer (it owns the Studio state); main only relays. */
const pendingToolCalls = new Map<string, (result: AiToolResult) => void>()

function runToolInRenderer(event: Electron.IpcMainInvokeEvent, call: AiToolCall): Promise<AiToolResult> {
  const sender = event.sender
  return new Promise<AiToolResult>((resolve) => {
    const callId = call.id
    const settle = (result: AiToolResult): void => {
      pendingToolCalls.delete(callId)
      resolve(result)
    }
    const timer = setTimeout(() => settle({ ok: false, content: JSON.stringify({ error: 'tool timed out after 60s' }) }), 60_000)
    pendingToolCalls.set(callId, (result) => {
      clearTimeout(timer)
      settle(result)
    })
    if (sender.isDestroyed()) {
      settle({ ok: false, content: JSON.stringify({ error: 'window closed' }) })
      return
    }
    sender.send(Events.aiToolCall, { callId, name: call.name, arguments: call.arguments })
  })
}

export function registerIpc(): void {
  // Keeps the engine on the newest release while settings.engineAutoUpdate is on.
  startEngineAutoUpdate()
  // Learn which GPUs this computer has (AMD / Intel via the small Vulkan probe) without blocking start-up.
  void startupEnginePlan().catch((error: unknown) => console.warn('[engine-plan]', error instanceof Error ? error.message : error))

  handle(Ipc.appInfo, null, () => {
    const settings = getSettings()
    return {
      name: 'MossStudio',
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
      platform: process.platform,
      arch: process.arch,
      dataPath: paths.root(),
      enginePath: paths.engineRoot(),
      modelsPath: paths.models(settings.modelsRoot),
      modelDirectories: {
        dit: paths.roleRoot('dit', settings.modelsRoot, settings.modelDirectories),
        textEncoder: paths.roleRoot('text_encoder', settings.modelsRoot, settings.modelDirectories),
        vae: paths.roleRoot('vae', settings.modelsRoot, settings.modelDirectories),
        support: paths.roleRoot('support', settings.modelsRoot, settings.modelDirectories),
        adapters: paths.adapters(settings.modelsRoot, settings.modelDirectories),
      },
      acrylic: false,
      backend: getBackendInfo(),
    }
  })

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

  handle(Ipc.aiConversationRename, schemas.aiConversationTitle, ({ id, title }) => renameConversation(id, title))

  handle(Ipc.aiToolResult, schemas.aiToolResult, ({ callId, result }) => {
    pendingToolCalls.get(callId)?.(result)
    return true
  })

  handle(Ipc.aiChat, schemas.aiChat, (input, event) =>
    chat(input, {
      emit: (payload) => {
        if (!event.sender.isDestroyed()) event.sender.send(Events.aiStream, payload)
      },
      runTool: (call) => runToolInRenderer(event, call),
      tools: STUDIO_TOOLS,
    }),
  )

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

  handle(Ipc.gbcVersionCreate, schemas.gbcVersionCreate, ({ branch, commit, name }) =>
    createGbcVersion(getSettings(), branch, commit, name),
  )

  handle(Ipc.gbcVersionRemove, schemas.gbcVersionRemove, async ({ id }) => {
    await removeGbcVersion(getSettings(), id)
    return true
  })

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

  handle(Ipc.copyText, schemas.copyText, async ({ text }) => {
    await clipboard.writeText(text)
    return true
  })

  handle(Ipc.devicesList, null, () => listDevices(getSettings()))
  handle(Ipc.gpuInventory, null, () => getGpuInventory())
  handle(Ipc.gpuInventoryRefresh, null, () => refreshGpuInventory())

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

  handle(Ipc.trainerRemoteCreate, schemas.trainerRemoteCreate, ({ hostId, ...input }) => remoteCreateVersion(getSettings(), hostId, input))

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

  handle(Ipc.trainerCommits, schemas.trainerCommits, ({ branch, limit }) => listTrainerCommits(getSettings(), branch, limit))

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
    const { hfToken, ...settingsPatch } = patch
    if (hfToken !== undefined) saveHfToken('local', hfToken)
    const settings = updateSettings(settingsPatch)
    // A GPU switched to another engine frees its old moss-server's memory now, not at its next job.
    releaseAfterSettingsChange(before, settings)
    if (before.theme !== settings.theme) applyThemeSource(settings.theme)
    if (!before.engineAutoUpdate && settings.engineAutoUpdate) clearEngineAutoUpdateHold()
    invalidateEngineReadiness()
    ensureDirs(settings.modelsRoot, settings.modelDirectories)
    if (before.lanWebEnabled !== settings.lanWebEnabled || before.lanWebPort !== settings.lanWebPort) {
      stopBackend()
      await startBackend()
    }
    const modelDirsChanged =
      before.modelsRoot !== settings.modelsRoot || JSON.stringify(before.modelDirectories) !== JSON.stringify(settings.modelDirectories)
    emit(Events.settingsChanged, settings)
    if (modelDirsChanged) emit(Events.modelsChanged, { reason: 'settings' })
    return settings
  })

  handle(Ipc.envScan, null, () => scanEnvironment(getSettings(), (event) => emit(Events.envProgress, event)))

  handle(Ipc.updateState, null, () => updaterApi.state())
  handle(Ipc.updateCheck, null, () => updaterApi.check())
  handle(Ipc.updateDownload, null, () => updaterApi.download())
  handle(Ipc.updateCancel, null, () => updaterApi.cancel())
  handle(Ipc.updateRestart, null, () => updaterApi.restart())
  handle(Ipc.updateRestartWhenIdle, schemas.updateToggle, ({ enabled }) => updaterApi.restartWhenIdle(enabled))
  handle(Ipc.updateRollback, null, () => updaterApi.rollback())
  handle(Ipc.updateSetChannel, schemas.updateSetChannel, ({ channel }) => updaterApi.setChannel(channel))
  handle(Ipc.updateSetAutoDownload, schemas.updateToggle, ({ enabled }) => updaterApi.setAutoDownload(enabled))
  handle(Ipc.updateUnskip, null, () => updaterApi.unskip())
  handle(Ipc.updateRetryFailed, null, () => updaterApi.retryFailed())
  handle(Ipc.updateDismissFailed, null, () => updaterApi.dismissFailed())

  handle(Ipc.mossInferDownload, schemas.mossInferDownload, async ({ channel, packages, cudaWheels, releaseTag, all }) => {
    // Without packages: whatever the plan says this computer is missing (one package per kind of GPU).
    const state = await installEnginePlan({ channel, releaseTag, cudaWheels, packages: packagesFromIds(packages), all })
    // Choosing an older release by hand pins it, so auto-update does not undo the rollback.
    if (state.phase === 'done' && channel === 'stable') await recordManualEngineInstall(releaseTag)
    return state
  })

  handle(Ipc.engineStatus, null, () => engineReadiness())

  handle(Ipc.enginePlan, schemas.enginePlan, (options) => getEnginePlan(options ?? {}))

  handle(Ipc.engineVersions, null, () => localEngineVersions())

  handle(Ipc.engineVersionSelect, schemas.engineVersionId, async ({ id }) => {
    const result = await selectLocalEngineVersion(id)
    invalidateEngineReadiness()
    return result
  })

  handle(Ipc.engineVersionRemove, schemas.engineVersionId, ({ id }) => removeLocalEngineVersion(id))

  handle(Ipc.engineSelectDirectory, schemas.engineSelectDirectory, ({ path }) => selectLocalEngineDirectory(path))

  handle(Ipc.engineProbe, null, () => probeLocalEngine())

  handle(Ipc.engineFeatures, schemas.engineFeatures, (target) => getEngineFeatures(target))

  handle(Ipc.studioImportImage, schemas.studioImportImage, ({ projectId, path, bytes }) =>
    bytes ? importImageBytes(projectId, bytes) : importImageFile(projectId, path!),
  )

  handle(Ipc.studioSaveMask, schemas.studioSaveMask, ({ projectId, canvasId, png, replaces }) =>
    saveMask(projectId, canvasId, png, { replaces, inUse: activeJobInputPaths() }),
  )

  handle(Ipc.controlAdaptersList, null, () => listControlAdapters())

  handle(Ipc.controlAdaptersAdd, schemas.controlAdapterAdd, (input) => addControlAdapter(input))

  handle(Ipc.controlAdaptersRemove, schemas.controlAdapterRemove, (input) => removeControlAdapter(input))

  handle(Ipc.engineRemoteStatus, schemas.engineRemoteStatus, ({ hostId, refreshCuda }) => remoteEngineInfo(hostId, refreshCuda))

  handle(Ipc.engineSystemCuda, schemas.engineSystemCuda, () => detectSystemCuda())

  handle(Ipc.sshTerminalOpen, schemas.sshTerminalOpen, ({ hostId }) => openSshTerminal(hostId))

  handle(Ipc.sshTerminalList, null, () => listSshTerminals())

  handle(Ipc.sshTerminalInput, schemas.sshTerminalInput, ({ id, data }) => {
    inputSshTerminal(id, data)
    return true
  })

  handle(Ipc.sshTerminalClose, schemas.sshTerminalClose, ({ id }) => {
    closeSshTerminal(id)
    return true
  })

  handle(Ipc.mossInferCudaLibs, schemas.mossInferCudaLibs, () => installMossInferCudaLibs())

  handle(Ipc.engineInstallRemote, schemas.engineInstallRemote, async ({ hostId, ...options }) => {
    const host = getTrainingHost(getSettings(), hostId)
    if (!host) throw new Error('主机不存在')
    return installRemoteEngine(
      host,
      (phase, message, percent, transfer) => emit(Events.engineRemoteProgress, { hostId, phase, message, percent, ...transfer }),
      options,
    )
  })

  handle(Ipc.enginePrepareRemoteModel, schemas.enginePrepareRemoteModel, async ({ hostId, repo }) => {
    const host = getTrainingHost(getSettings(), hostId)
    if (!host) throw new Error('主机不存在')
    const result = await prepareRemoteDefaultModel(host, repo)
    emit(Events.hostsChanged, { id: hostId })
    return result
  })

  handle(Ipc.mossInferDownloadState, null, () => getMossInferDownloadState())

  handle(Ipc.mossInferReleases, null, () => listMossInferReleases())

  handle(Ipc.mossInferDownloadCancel, null, () => cancelMossInferDownload())

  handle(Ipc.notificationTest, null, () => pushTestNotification())

  handle(Ipc.announcementsDismiss, schemas.announcementsDismiss, ({ id }) => {
    updaterApi.dismissAnnouncement(id)
    return true
  })

  handle(Ipc.projectsList, null, () => listProjects())

  handle(Ipc.projectGet, schemas.projectId, ({ id }) => getProject(id))

  handle(Ipc.projectSave, schemas.projectSave, (input) => {
    const saved = saveProject(input)
    // Masks painted over or cleared are no longer referenced: drop them (never one a job still reads).
    void pruneProjectMasks(saved, activeJobInputPaths()).catch(() => undefined)
    return saved
  })

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

  handle(Ipc.modelsRemoteDelete, schemas.modelsRemoteDelete, async ({ hostId, ids }) => {
    const host = getTrainingHost(getSettings(), hostId)
    if (!host) throw new Error('主机不存在')
    const result = await deleteRemoteModels(host, await getCatalog(getSettings(), true), ids)
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
    emit(Events.modelsChanged, { reason: 'import', ...imported })
    return { canceled: false, ...imported }
  })

  // Read-only discovery for a folder the user already has (e.g. a ComfyUI models
  // tree). Never writes into it; registration is a separate explicit call.
  handle(Ipc.modelsScan, schemas.modelsScan, async ({ directory }) => {
    let root = directory?.trim() ?? ''
    if (!root) {
      const picked = await dialog.showOpenDialog({
        title: '选择已有模型目录',
        buttonLabel: '扫描',
        properties: ['openDirectory'],
      })
      if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
      root = picked.filePaths[0]
    }
    return { canceled: false, ...(await scanModels(root)) }
  })

  handle(Ipc.modelsRegisterScan, schemas.modelsRegisterScan, async ({ items }) => {
    const result = await registerScannedModels(getSettings(), items)
    emit(Events.modelsChanged, { reason: 'register', ...result })
    return result
  })

  handle(Ipc.modelsCleanupEmpty, null, async () => {
    const removed = await cleanupEmptyModelDirs(getSettings())
    emit(Events.modelsChanged, { reason: 'cleanup', removed: removed.length })
    return { removed }
  })

  handle(Ipc.modelsImportAdapter, null, async () => {
    const result = await dialog.showOpenDialog({
      title: '导入 LoRA 文件',
      buttonLabel: '导入',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'LoRA / LyCORIS', extensions: ['safetensors'] }],
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true, adapters: [] }
    const settings = getSettings()
    const adapters = []
    for (const sourcePath of result.filePaths) {
      adapters.push(await importAdapterFile(settings, { sourcePath }))
    }
    invalidateCatalog()
    return { canceled: false, adapters }
  })

  handle(Ipc.modelsInstalled, null, async () => {
    const catalog = await getCatalog(getSettings())
    return catalog.models.filter((model) => model.installed)
  })

  handle(Ipc.modelBundleInstall, schemas.modelBundle, ({ id }) => installBundle(id, getSettings()))

  handle(Ipc.modelDownload, schemas.download, ({ kind, id }) => startDownload(kind, id, getSettings()))

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

  handle(Ipc.downloadsList, null, () => [...listDownloads(), ...listRemoteDownloads()])

  handle(Ipc.remoteDownloadsRefresh, schemas.remoteDownloadsRefresh, ({ hostId }) => refreshRemoteDownloads(hostId))
  handle(Ipc.remoteDownloadControl, schemas.remoteDownloadControl, ({ hostId, taskId, operation }) =>
    controlRemoteDownload(hostId, taskId, operation),
  )

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
    if (job?.logPath) await revealInFileManager(job.logPath)
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

  handle(Ipc.galleryTrash, schemas.galleryTrash, ({ path }) => trashGalleryItem(path))

  // Keep each output's generation details (project, model, steps…) next to the image.
  onJobCompleted((job) => {
    void recordJobOutputs(job).then((changed) => {
      if (changed) emit(Events.galleryChanged, { jobId: job.id })
    })
  })

  handle(Ipc.pickDialog, schemas.pickDialog, async ({ kind, title }) => {
    const result = await dialog.showOpenDialog({
      title,
      properties: kind === 'folder' ? ['openDirectory', 'createDirectory'] : ['openFile'],
      filters: kind === 'image' ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] : undefined,
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
    const settings = getSettings()
    const allowed = [
      paths.root(),
      paths.models(settings.modelsRoot),
      paths.engineRoot(),
      paths.outputs(),
      ...(['dit', 'text_encoder', 'vae', 'support'] as const).map((role) =>
        paths.roleRoot(role, settings.modelsRoot, settings.modelDirectories),
      ),
      paths.adapters(settings.modelsRoot, settings.modelDirectories),
    ]
    if (!allowed.some((base) => isInside(base, path))) throw new Error('路径不在允许范围内')
    if (!existsSync(path)) mkdirSync(path, { recursive: true })
    const stats = statSync(path)
    if (stats.isDirectory()) {
      await openDirectoryInFileManager(path)
      return true
    }
    if (!stats.isFile()) throw new Error('目标路径不可打开')
    const error = await shell.openPath(path)
    if (error) throw new Error(`无法打开文件：${error}`)
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
