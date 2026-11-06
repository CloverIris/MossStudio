// Reads zips with yauzl, the same reader the app's updater uses, so every check the pipeline
// makes on its own archives is a check on what clients will see.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { entryKind } from './zip.mjs'

const require = createRequire(fileURLToPath(new URL('../../../apps/desktop/package.json', import.meta.url)))
const yauzl = require('yauzl')

/**
 * Calls `onEntry({ name, kind, mode, size, read })` for every entry, in archive order.
 * `read()` resolves to the entry's uncompressed bytes (the link target for a symlink); an
 * entry that is not read is skipped.
 */
export function forEachZipEntry(path, onEntry) {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, autoClose: true }, (openError, zip) => {
      if (openError) return reject(openError)
      let failed = false
      const fail = (error) => {
        if (failed) return
        failed = true
        zip.close()
        reject(error)
      }
      zip.on('error', fail)
      zip.on('end', () => { if (!failed) resolve() })
      zip.on('entry', (entry) => {
        const { kind, mode } = entryKind(entry.externalFileAttributes, entry.fileName)
        const read = () => new Promise((res, rej) => {
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return rej(streamError)
            const chunks = []
            stream.on('data', (chunk) => chunks.push(chunk))
            stream.on('error', rej)
            stream.on('end', () => res(Buffer.concat(chunks)))
          })
        })
        Promise.resolve(onEntry({ name: entry.fileName, kind, mode, size: entry.uncompressedSize, read }))
          .then(() => { if (!failed) zip.readEntry() })
          .catch(fail)
      })
      zip.readEntry()
    })
  })
}

/** All entries with their bytes, keyed by name (directories have empty data). Small zips only. */
export async function readZip(path) {
  const entries = new Map()
  await forEachZipEntry(path, async (entry) => {
    entries.set(entry.name, { kind: entry.kind, mode: entry.mode, data: entry.kind === 'directory' ? Buffer.alloc(0) : await entry.read() })
  })
  return entries
}
