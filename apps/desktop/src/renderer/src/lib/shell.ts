import { create } from 'zustand'

export type ActivityTab = 'jobs' | 'notifications' | 'problems'

interface ShellState {
  activityOpen: boolean
  activityTab: ActivityTab
  /** Job whose log the Activity panel should show expanded. */
  focusedJobId: string | null
  /** Element in the title bar that pages can render context into (e.g. the project switcher). */
  titlebarSlot: HTMLElement | null
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
