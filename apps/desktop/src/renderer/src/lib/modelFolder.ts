/** What `models:import-folder` (在原位置使用这个模型文件夹) answers. */
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
  if (result.added) return `已登记 ${result.added} 个模型文件${result.duplicates ? `，${result.duplicates} 个重复的已跳过` : ''}`
  return '这个文件夹里的文件都已经登记过'
}
