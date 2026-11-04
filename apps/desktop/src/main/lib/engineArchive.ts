import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import * as yauzl from 'yauzl'
import { isInside } from './paths'
import { run } from './run'

export type EngineArchiveFormat = 'tar.gz' | 'zip'

async function extractZip(zip: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true })
  const root = resolve(dest)
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      zipfile?.close()
      rejectPromise(error)
    }
    let zipfile: yauzl.ZipFile | undefined
    yauzl.open(zip, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, opened) => {
      if (error || !opened) {
        fail(new Error(`无法打开 ZIP 引擎包：${error?.message ?? '未知错误'}`))
        return
      }
      zipfile = opened
      opened.on('error', fail)
      opened.on('end', () => {
        if (settled) return
        settled = true
        opened.close()
        resolvePromise()
      })
      opened.on('entry', (entry: yauzl.Entry) => {
        try {
          const name = entry.fileName.replace(/\\/g, '/')
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff
          if (
            !name ||
            name.startsWith('/') ||
            name.split('/').some((part) => part === '..' || part === '.' || part.includes(':')) ||
            (mode & 0xf000) === 0xa000
          ) {
            fail(new Error(`ZIP 引擎包包含不安全路径：${entry.fileName}`))
            return
          }
          const target = resolve(root, ...name.split('/'))
          const relative = target.slice(root.length)
          if (target !== root && (!relative.startsWith(sep) || !isInside(root, target))) {
            fail(new Error(`ZIP 引擎包路径越界：${entry.fileName}`))
            return
          }
          if (entry.fileName.endsWith('/') || (mode & 0xf000) === 0x4000) {
            mkdirSync(target, { recursive: true })
            opened.readEntry()
            return
          }
          mkdirSync(dirname(target), { recursive: true })
          opened.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail(new Error(`无法读取 ZIP 文件 ${entry.fileName}：${streamError?.message ?? '未知错误'}`))
              return
            }
            const output = createWriteStream(target, { flags: 'wx' })
            void pipeline(stream, output).then(
              () => opened.readEntry(),
              (pipelineError: unknown) =>
                fail(new Error(`ZIP 解压失败 ${entry.fileName}：${pipelineError instanceof Error ? pipelineError.message : String(pipelineError)}`)),
            )
          })
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
        }
      })
      opened.readEntry()
    })
  })
}

/** 使用上游包格式解压，不能根据下载临时文件的后缀猜测。 */
export async function extractArchive(
  archive: string,
  dest: string,
  format: EngineArchiveFormat,
): Promise<void> {
  mkdirSync(dest, { recursive: true })
  if (format === 'zip') {
    await extractZip(archive, dest)
    return
  }
  const result = await run('tar', ['-xf', archive, '-C', dest], { timeoutMs: 300_000 })
  if (result.code !== 0) throw new Error(`引擎包解压失败：${result.stderr.slice(0, 300) || '系统 tar 执行失败'}`)
}
