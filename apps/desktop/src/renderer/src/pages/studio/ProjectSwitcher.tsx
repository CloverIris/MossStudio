import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { Button, ConfirmDialog, Field, Input, Modal } from '../../components/ui'
import { MenuGap, MenuItem, Popover } from '../../components/common/Popover'
import { relative } from '../../lib/format'
import type { StudioProject } from './useStudioProject'

const STATUS_TEXT = { idle: '', saving: '保存中…', saved: '已保存', error: '保存失败' } as const

/** Project name with its menu, plus the quiet autosave status, shown in the title bar. */
export function ProjectSwitcher({ project }: { project: StudioProject }): React.JSX.Element {
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [deleting, setDeleting] = useState(false)
  const others = project.projects.filter((item) => item.id !== project.projectId)

  return (
    <>
      <Popover
        label="项目"
        trigger={(props) => (
          <button
            type="button"
            onClick={props.toggle}
            aria-expanded={props['aria-expanded']}
            aria-controls={props['aria-controls']}
            aria-haspopup={props['aria-haspopup']}
            data-project-switcher
            className="inline-flex h-7 max-w-[260px] items-center gap-1.5 rounded-md px-2.5 text-ui font-semibold text-ink transition-colors hover:bg-well"
          >
            <span className="truncate">{project.projectName}</span>
            <ChevronDown className="size-3.5 shrink-0 text-ink-2" aria-hidden="true" />
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuItem onSelect={() => { close(); void project.newProject() }}>新建项目</MenuItem>
            <MenuItem onSelect={() => { close(); setRenameDraft(project.projectName); setRenaming(true) }}>重命名</MenuItem>
            <MenuItem tone="danger" disabled={!project.projectId} onSelect={() => { close(); setDeleting(true) }}>删除项目</MenuItem>
            {others.length ? (
              <>
                <MenuGap />
                <div className="px-2.5 pb-1 text-caption font-medium text-ink-2">切换到</div>
                <div className="flex max-h-[320px] flex-col gap-0.5 overflow-y-auto">
                  {others.map((item) => (
                    <MenuItem key={item.id} hint={relative(item.updatedAt)} onSelect={() => { close(); void project.openProject(item.id) }}>
                      {item.name}
                    </MenuItem>
                  ))}
                </div>
              </>
            ) : null}
          </>
        )}
      </Popover>
      <span role="status" title={project.saveError ?? undefined} className={project.saveStatus === 'error' ? 'text-caption text-danger' : 'text-caption text-ink-2'}>
        {STATUS_TEXT[project.saveStatus]}
      </span>

      <Modal
        open={renaming}
        onClose={() => setRenaming(false)}
        title="重命名项目"
        width="max-w-md"
        footer={(
          <>
            <Button tone="ghost" size="md" onClick={() => setRenaming(false)}>取消</Button>
            <Button tone="primary" size="md" disabled={!renameDraft.trim()} onClick={() => { project.rename(renameDraft); setRenaming(false) }}>保存</Button>
          </>
        )}
      >
        <form onSubmit={(event) => { event.preventDefault(); if (renameDraft.trim()) { project.rename(renameDraft); setRenaming(false) } }}>
          <Field label="名称">
            <Input data-dialog-initial-focus value={renameDraft} maxLength={200} onChange={(event) => setRenameDraft(event.target.value)} />
          </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`删除「${project.projectName}」？`}
        description="项目里的画面会一起删除。已经生成的图片仍保留在作品里。"
        confirmLabel="删除项目"
        onConfirm={() => {
          setDeleting(false)
          if (project.projectId) void project.deleteProject(project.projectId)
        }}
      />
    </>
  )
}
