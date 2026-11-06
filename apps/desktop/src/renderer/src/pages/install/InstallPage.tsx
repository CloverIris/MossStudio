import { Check, FileText, Info } from 'lucide-react'
import { Advanced, Button, FieldLabel, Spinner } from '../../components/ui'
import { Checkbox } from '../../components/common/Checkbox'
import {
  downgradeText,
  folderNote,
  folderProblemMessage,
  legacyInPlace,
  oldInstallText,
  progressLabel,
  progressPercent,
  setupScreen,
  spaceLine,
  type FolderCheck,
} from './installModel'
import { legacyWarning } from '@shared/setup'
import { ChoiceList, FailureBlock, FolderField, FolderProblem, PathText, ProgressBlock, Screen } from './parts'
import { useInstall, type SetupController } from './useInstall'
import { ScreenHeading, WindowChrome } from './WindowChrome'

function FolderCheckLine({ check, onUse }: { check: FolderCheck | null; onUse: (path: string) => void }): React.JSX.Element | null {
  const message = check ? folderProblemMessage(check) : null
  if (!message) return null
  const suggestion = message.suggestion
  return (
    <FolderProblem
      text={message.text}
      action={suggestion ? { label: suggestion.label, onClick: () => onUse(suggestion.path) } : undefined}
    />
  )
}

function LegacyCard({ setup }: { setup: SetupController }): React.JSX.Element | null {
  const legacy = setup.legacy
  if (!legacy) return null
  const old = oldInstallText(legacy)
  const kept = legacy.source === 'kept'
  // Installing into the old folder converts it in place (or, for kept data, finds it as data/), so its data always stays in use.
  const inPlace = legacyInPlace(setup.state!.platform, legacy, setup.location)
  const warning = legacyWarning(legacy, setup.legacyMode, inPlace)
  return (
    <section aria-label={kept ? '保留的数据' : '旧版数据'} className="flex flex-col gap-1 rounded-xl bg-surface p-1.5" data-legacy-card>
      <div className="flex flex-col gap-0.5 px-3.5 pb-1.5 pt-2">
        {/* Same shape as the location card: a label, the main line, then the detail. */}
        <FieldLabel as="h2">{kept ? '保留的数据' : '旧版数据'}</FieldLabel>
        <p className="text-control text-ink">{old.title}</p>
        <p className="text-caption text-ink-2 [overflow-wrap:anywhere]">{old.description}</p>
      </div>
      {inPlace ? (
        <p className="px-3.5 pb-2.5 text-ui text-ink">
          {kept
            ? '装在原来的文件夹里：会继续使用这些作品、模型和设置。'
            : '装在旧版所在的文件夹里：旧的程序文件会被替换，作品、模型和设置原地保留。'}
        </p>
      ) : (
        <ChoiceList
          label={kept ? '保留的数据' : '旧版数据'}
          value={setup.legacyMode}
          onChange={setup.setLegacyMode}
          disabled={setup.starting}
          options={[
            { value: 'reuse', title: '继续使用这些数据（不复制）', description: '新版本直接使用它们' },
            { value: 'fresh', title: '重新开始', description: '旧数据留在原处，不会删除' },
          ]}
        />
      )}
      {/* Per choice: reuse keeps using the old data\ (do not delete the folder); fresh may delete it. */}
      {warning ? (
        <p className="flex items-start gap-2 px-3.5 pb-2 pt-1 text-caption text-ink-2" data-legacy-warning={setup.legacyMode}>
          <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" strokeWidth={1.6} />
          <span className="[overflow-wrap:anywhere]">{warning}</span>
        </p>
      ) : null}
    </section>
  )
}

function ChooseScreen({ setup }: { setup: SetupController }): React.JSX.Element {
  const state = setup.state!
  const location = setup.location
  const mac = state.platform === 'darwin'
  const blocked = setup.checking || !location?.ok || (mac && setup.dataLocation !== null && !setup.dataLocation.ok)
  const dataPath = setup.dataLocation?.path ?? state.defaults.dataRoot
  // The card already says the data stays in use when it is installed in place.
  const note = setup.legacy && legacyInPlace(state.platform, setup.legacy, location) ? null : folderNote(location)
  return (
    <Screen
      actions={
        <Button tone="primary" size="lg" className="min-w-28" disabled={blocked || setup.starting} onClick={setup.install}>
          {setup.starting ? <Spinner /> : null}安装
        </Button>
      }
    >
      {/* The version sits in the window strip: 640×480 needs the room for the old-install card. */}
      <ScreenHeading title="安装 MossStudio" subtitle={setup.legacy ? undefined : '选好位置后点“安装”，装好会自动打开。'} />

      <FolderField
        label="安装位置"
        path={location?.path ?? state.location.path}
        detail={setup.checking || !location ? '正在检查这个位置…' : spaceLine(state.requiredBytes, location.freeBytes)}
        onChange={setup.chooseLocation}
        disabled={setup.starting}
      >
        <FolderCheckLine check={location} onUse={setup.selectLocation} />
        {note && !setup.checking ? (
          <p className="flex items-start gap-2 px-3.5 pb-2 text-caption text-ink-2" data-folder-note>
            <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" strokeWidth={1.6} />
            <span className="[overflow-wrap:anywhere]">{note}</span>
          </p>
        ) : null}
      </FolderField>

      <LegacyCard setup={setup} />

      {mac && dataPath ? (
        <Advanced summary={`数据位置：${dataPath}`} className="rounded-xl bg-surface p-1.5">
          <div className="px-1 pt-1">
            <FolderField
              label="数据位置"
              path={dataPath}
              detail="作品、模型和设置保存在这里。"
              onChange={setup.chooseDataLocation}
              disabled={setup.starting}
            >
              <FolderCheckLine check={setup.dataLocation} onUse={setup.selectDataLocation} />
            </FolderField>
          </div>
        </Advanced>
      ) : null}

      {!mac && !setup.legacy ? (
        <Advanced summary="旧版装在别的位置？" className="rounded-xl bg-surface p-1.5">
          <div className="flex flex-col gap-2 px-1 pt-1">
            <div className="flex items-center gap-4 rounded-xl bg-surface px-5 py-3.5">
              <p className="min-w-0 flex-1 text-caption text-ink-2">
                选择旧版 MossStudio 所在的文件夹，可以继续使用里面的作品、模型和设置。
              </p>
              <Button onClick={setup.chooseLegacy} disabled={setup.starting}>
                选择文件夹…
              </Button>
            </div>
            {setup.legacyNotFound ? (
              <p role="alert" className="px-1 text-caption text-warn">
                这个文件夹里没有旧版 MossStudio，请换一个。
              </p>
            ) : null}
          </div>
        </Advanced>
      ) : null}
    </Screen>
  )
}

function DowngradeScreen({ setup }: { setup: SetupController }): React.JSX.Element {
  const state = setup.state!
  const installed = state.installed?.version ?? ''
  const text = downgradeText(installed, state.version)
  return (
    <Screen
      actions={
        <>
          <Button size="lg" onClick={setup.close}>
            保留 {installed}
          </Button>
          <Button tone="primary" size="lg" disabled={setup.starting} onClick={setup.acceptDowngrade}>
            {setup.starting ? <Spinner /> : null}换成 {state.version}
          </Button>
        </>
      }
    >
      <ScreenHeading title={text.title} subtitle={text.description} />
    </Screen>
  )
}

function ProgressScreen({ setup }: { setup: SetupController }): React.JSX.Element {
  const state = setup.state!
  const run = setup.run ?? { status: 'running' as const, step: null, percent: null }
  const root = state.installed?.root ?? setup.location?.path ?? state.location.path
  const title =
    state.kind === 'first'
      ? '正在安装 MossStudio'
      : state.kind === 'repair'
        ? '正在修复 MossStudio'
        : `正在安装 MossStudio ${state.version}`
  return (
    <Screen>
      <ScreenHeading title={title} subtitle="请稍等，装好后会自动打开。你的作品、模型和设置不受影响。" />
      <ProgressBlock
        label={progressLabel(run)}
        percent={progressPercent(run)}
        detail={
          <span className="flex min-w-0 gap-1">
            <span className="shrink-0">安装到</span>
            <PathText path={root} className="text-caption text-ink-2" />
          </span>
        }
      />
    </Screen>
  )
}

function DoneScreen({ setup }: { setup: SetupController }): React.JSX.Element {
  const state = setup.state!
  const warnings = state.result?.warnings ?? []
  return (
    <Screen
      actions={
        state.canEject ? (
          <Button tone="primary" size="lg" disabled={setup.launching} onClick={setup.launch}>
            {setup.launching ? <Spinner /> : null}打开 MossStudio
          </Button>
        ) : undefined
      }
    >
      <ScreenHeading title="安装完成" subtitle={`MossStudio ${state.version} 已装好。`} />
      {state.canEject ? (
        <div className="rounded-xl bg-surface p-1.5">
          <Checkbox
            checked={setup.eject}
            onCheckedChange={setup.setEject}
            label="打开后推出安装盘"
            description="安装盘里的文件已经不需要了。"
          />
        </div>
      ) : (
        <div className="flex items-center gap-2.5 text-control text-ink" role="status">
          <span className="flex size-6 items-center justify-center rounded-full bg-ok-soft text-ok">
            <Check className="size-4" aria-hidden="true" strokeWidth={1.6} />
          </span>
          正在打开 MossStudio…
          <Spinner className="text-ink-2" />
        </div>
      )}
      {warnings.length ? (
        <ul className="flex flex-col gap-1 px-1 text-caption text-ink-2" aria-label="提示">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </Screen>
  )
}

function FailedScreen({ setup }: { setup: SetupController }): React.JSX.Element {
  return (
    <Screen
      actions={
        <>
          <Button tone="ghost" size="lg" onClick={setup.close}>
            关闭
          </Button>
          <Button size="lg" onClick={setup.openLog}>
            <FileText className="size-4" strokeWidth={1.6} />
            查看日志
          </Button>
          <Button tone="primary" size="lg" disabled={setup.starting} onClick={setup.retry}>
            {setup.starting ? <Spinner /> : null}重试
          </Button>
        </>
      }
    >
      <ScreenHeading title="安装没有完成" subtitle="你的作品、模型和设置没有受到影响。" />
      <FailureBlock>
        <p className="text-control text-ink">{setup.error ?? '安装时出了问题。'}</p>
        <p className="mt-1 text-caption text-ink-2">可以先关闭正在使用这个文件夹的程序，然后重试。还是不行的话，把日志发给我们。</p>
      </FailureBlock>
    </Screen>
  )
}

function LoadingScreen({ setup }: { setup: SetupController }): React.JSX.Element {
  return (
    <Screen
      actions={
        setup.loadError ? (
          <Button size="lg" onClick={setup.close}>
            关闭
          </Button>
        ) : undefined
      }
    >
      <ScreenHeading title="安装 MossStudio" subtitle={setup.loadError ?? undefined} />
      {setup.loadError ? null : (
        <div className="flex items-center gap-2 text-ui text-ink-2" role="status">
          <Spinner />
          正在准备…
        </div>
      )}
    </Screen>
  )
}

/** The setup window (`#/install`): where to install, then progress, then done or failed. */
export function InstallPage(): React.JSX.Element {
  const setup = useInstall()
  const screen = setupScreen({
    kind: setup.state?.kind ?? null,
    phase: setup.state?.phase ?? null,
    downgradeAccepted: setup.downgradeAccepted,
  })
  const busy = screen === 'progress' || (screen === 'done' && !setup.state?.canEject)
  return (
    <WindowChrome
      title={setup.state ? `MossStudio ${setup.state.version} 安装` : 'MossStudio 安装'}
      onClose={setup.close}
      closeDisabled={busy}
    >
      <div data-setup-screen={screen} className="h-full">
        {screen === 'loading' ? <LoadingScreen setup={setup} /> : null}
        {screen === 'choose' ? <ChooseScreen setup={setup} /> : null}
        {screen === 'downgrade' ? <DowngradeScreen setup={setup} /> : null}
        {screen === 'progress' ? <ProgressScreen setup={setup} /> : null}
        {screen === 'done' ? <DoneScreen setup={setup} /> : null}
        {screen === 'failed' ? <FailedScreen setup={setup} /> : null}
      </div>
    </WindowChrome>
  )
}
