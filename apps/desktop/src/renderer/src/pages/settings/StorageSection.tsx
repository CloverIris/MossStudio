import { FolderOpen, Plus, X } from 'lucide-react'
import type { ModelDirectoryId } from '@shared/types'
import { useApp } from '../../store'
import { Advanced, Button, Group, IconButton, Row, Section, useToast } from '../../components/ui'
import { PathValue } from '../../components/common/PathValue'
import { FolderRow, SectionBody, StackRow, errorText, pickFolder, useOpenPath, useSaveSettings } from './fields'
import { useAppInfo } from './useAppInfo'

const MODEL_FOLDERS: Array<{ id: ModelDirectoryId; label: string }> = [
  { id: 'dit', label: '主模型（DiT）' },
  { id: 'textEncoder', label: '文本编码器' },
  { id: 'vae', label: 'VAE' },
  { id: 'support', label: '运行配置' },
  { id: 'adapters', label: 'LoRA' },
]

export function StorageSection(): React.JSX.Element {
  const settings = useApp((state) => state.settings)!
  const save = useSaveSettings()
  const info = useAppInfo()
  const openPath = useOpenPath()
  const toast = useToast()
  const galleryRoots = settings.galleryRoots ?? []
  const modelDirectories = settings.modelDirectories ?? {}

  async function addGalleryRoot(): Promise<void> {
    try {
      const path = await pickFolder('添加作品来源文件夹')
      if (!path || galleryRoots.includes(path)) return
      await save({ galleryRoots: [...galleryRoots, path] })
    } catch (error) {
      toast.push(errorText(error), 'error')
    }
  }

  return (
    <SectionBody>
      <Section title="位置">
        <Group>
          {/* Every folder on this page reads the same: a title, then the path in a PathValue. */}
          <StackRow title="数据文件夹" description="作品、设置和日志都在这里。">
            <div className="flex min-w-0 items-center gap-2">
              <PathValue value={info?.dataPath} empty="正在读取…" className="flex-1" />
              <IconButton label="在文件管理器中打开" disabled={!info?.dataPath} onClick={() => openPath(info?.dataPath)}>
                <FolderOpen className="size-4" strokeWidth={1.6} />
              </IconButton>
            </div>
          </StackRow>
          <FolderRow
            title="模型文件夹"
            description="下载的模型保存在这里。更改后，新的下载会保存到新位置，已下载的模型不会移动。"
            value={settings.modelsRoot}
            fallback={info?.modelsPath}
            pickTitle="选择模型文件夹"
            onChange={(modelsRoot) => save({ modelsRoot })}
          />
        </Group>
      </Section>

      <Section
        title="作品来源"
        description="作品页默认显示生成的图片；也可以加入其他文件夹里的图片。"
        actions={
          <Button onClick={() => void addGalleryRoot()}>
            <Plus className="size-4" strokeWidth={1.6} />
            添加文件夹
          </Button>
        }
      >
        <Group>
          {galleryRoots.length === 0 ? (
            <Row title="只显示生成的图片" description="还没有添加其他文件夹。" />
          ) : (
            galleryRoots.map((root) => (
              <div key={root} className="flex min-w-0 items-center gap-2 px-3.5 py-2">
                <PathValue value={root} className="flex-1" />
                <IconButton label="在文件管理器中打开" onClick={() => openPath(root)}>
                  <FolderOpen className="size-4" strokeWidth={1.6} />
                </IconButton>
                {/* X: the folder only leaves the list; nothing on disk is deleted. */}
                <IconButton label="移除这个来源" onClick={() => void save({ galleryRoots: galleryRoots.filter((item) => item !== root) })}>
                  <X className="size-4" strokeWidth={1.6} />
                </IconButton>
              </div>
            ))
          )}
        </Group>
      </Section>

      <Group>
        <Advanced summary="按类型分开存放模型、下载前的磁盘检查">
          <div className="flex flex-col gap-0.5">
            <p className="px-3.5 pb-1 text-caption text-ink-2">
              留空时各类型放在模型文件夹下的子文件夹里。模型页的高级选项改的也是这些位置。
            </p>
            {MODEL_FOLDERS.map(({ id, label }) => (
              <FolderRow
                key={id}
                title={label}
                value={modelDirectories[id] ?? null}
                fallback={info?.modelDirectories?.[id]}
                pickTitle={`选择${label}文件夹`}
                onChange={(path) => save({ modelDirectories: { ...modelDirectories, [id]: path } })}
              />
            ))}
            <Row title="磁盘空间检查" description="下载模型、LoRA 和引擎前，会先检查目标磁盘的可用空间；空间不够时不会开始下载。">
              <span className="text-ui text-ink-2">自动</span>
            </Row>
          </div>
        </Advanced>
      </Group>
    </SectionBody>
  )
}
