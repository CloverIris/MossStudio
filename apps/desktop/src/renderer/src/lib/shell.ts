import { create } from 'zustand'

export type ActivityTab = 'jobs' | 'notifications' | 'problems'

/** One step of a plan the assistant is waiting to have approved (a tool call, not run yet). */
export interface PlannedStep {
  tool: string
  args: Record<string, unknown>
}

interface ShellState {
  activityOpen: boolean
  activityTab: ActivityTab
  /** Job whose log the Activity panel should show expanded. */
  focusedJobId: string | null
  /** Element in the title bar that pages can render context into (e.g. the project switcher). */
  titlebarSlot: HTMLElement | null
  /** The steps of the assistant's plan waiting for 审批: the board previews them on the selected 画面. */
  planPreview: readonly PlannedStep[] | null
  setPlanPreview: (steps: readonly PlannedStep[] | null) => void
  openActivity: (tab?: ActivityTab, jobId?: string | null) => void
  closeActivity: () => void
  toggleActivity: () => void
  setActivityTab: (tab: ActivityTab) => void
  focusJob: (jobId: string | null) => void
  setTitlebarSlot: (element: HTMLElement | null) => void
}

/** UI-only state of the app frame: never persisted, never sent to the main process. */
export const useShell = create<ShellState>((set) => ({
  activityOpen: false,
  activityTab: 'jobs',
  focusedJobId: null,
  titlebarSlot: null,
  planPreview: null,
  setPlanPreview: (planPreview) => set({ planPreview }),
  openActivity: (tab, jobId) =>
    set((state) => ({
      activityOpen: true,
      activityTab: tab ?? state.activityTab,
      focusedJobId: jobId === undefined ? state.focusedJobId : jobId,
    })),
  closeActivity: () => set({ activityOpen: false }),
  toggleActivity: () => set((state) => ({ activityOpen: !state.activityOpen })),
  setActivityTab: (activityTab) => set({ activityTab }),
  focusJob: (focusedJobId) => set({ focusedJobId }),
  setTitlebarSlot: (titlebarSlot) => set({ titlebarSlot }),
}))
