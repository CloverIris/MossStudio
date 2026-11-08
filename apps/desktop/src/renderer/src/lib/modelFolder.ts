/** What `models:import-folder` (添加整个模型文件夹) answers. */
export interface ImportFolderResult {
  canceled: boolean
  added: number
  /** Already registered (updated in place). */
  duplicates: number
  /** Names of the model folders found, when the folder held diffusers models. */
  folders?: string[]
}

/** One plain sentence about what happened. */
export function importFolderMessage(result: ImportFolderResult): string {
  if (result.folders?.length) {
    const names = result.folders.join('、')
    return result.added ? `已在原位置使用 ${names}` : `${names} 已经在用了`
  }
  if (result.added) return `已添加 ${result.added} 个模型文件${result.duplicates ? `，${result.duplicates} 个重复的已跳过` : ''}`
  return '这个文件夹里的文件都已经添加过'
}

/** What `models:use-folder` (用电脑上的模型文件…) answers: a complete model folder is added as with import-folder. */
export interface UseFolderResult extends ImportFolderResult {
  /** Otherwise the registered files for 自己组合's slots, or null when none was found. */
  slots: { dit: string | null; textEncoder: string | null; vae: string | null } | null
}
