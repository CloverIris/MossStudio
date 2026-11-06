/**
 * install.json and locator.json IO. Writes are atomic (temp file in the same folder,
 * fsync, rename) and keep keys this version does not know, so a newer launcher's or
 * app's fields survive an older app rewriting the file. Reads are schema-validated:
 * a missing, corrupt or invalid file reads as null.
 */
import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import type { ZodObject, ZodRawShape } from 'zod'
import { installLocatorSchema, installRecordSchema, keptDataSchema, type InstallLocator, type InstallRecord, type KeptData } from '@shared/install'

/** The JSON object in `file`, or null when it is missing or not a JSON object. */
export function readJsonObject(file: string): Record<string, unknown> | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const value = JSON.parse(text.replace(/^﻿/, '')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Write `value` as JSON to `file` atomically. On Windows the rename can fail briefly
 * while another process (the launcher, an antivirus scan) has the target open, so it
 * is retried for about a second.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const fd = openSync(temp, 'w')
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temp, file)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt < 10 && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) {
        sleep(100)
        continue
      }
      rmSync(temp, { force: true })
      throw error
    }
  }
}

function readValidated<T>(file: string, schema: ZodObject<ZodRawShape>): T | null {
  const raw = readJsonObject(file)
  if (!raw) return null
  const parsed = schema.safeParse(raw)
  return parsed.success ? (parsed.data as T) : null
}

/**
 * Write a validated document, merged over the keys already in a valid file: unknown keys
 * are kept, known keys take the new value, and known optional keys the new document
 * leaves out are removed (so clearing `pending` really clears it).
 */
function writeMerged(file: string, schema: ZodObject<ZodRawShape>, value: Record<string, unknown>): void {
  const valid = schema.parse(value) as Record<string, unknown>
  // Keep unknown keys only from a file that is one of ours; never merge into foreign JSON.
  const existing = readJsonObject(file)
  const base = existing && schema.safeParse(existing).success ? existing : {}
  const merged: Record<string, unknown> = { ...base, ...valid }
  for (const key of Object.keys(schema.shape)) {
    if (valid[key] === undefined) delete merged[key]
  }
  writeJsonAtomic(file, merged)
}

export function readInstallRecord(file: string): InstallRecord | null {
  return readValidated<InstallRecord>(file, installRecordSchema)
}

export function writeInstallRecord(file: string, record: InstallRecord): void {
  writeMerged(file, installRecordSchema, record as unknown as Record<string, unknown>)
}

/** Read, change and write install.json; null (and nothing written) when there is no valid record. */
export function updateInstallRecord(file: string, change: (record: InstallRecord) => InstallRecord): InstallRecord | null {
  const current = readInstallRecord(file)
  if (!current) return null
  const next = change(current)
  writeInstallRecord(file, next)
  return next
}

export function readLocator(file: string): InstallLocator | null {
  return readValidated<InstallLocator>(file, installLocatorSchema)
}

export function writeLocator(file: string, locator: InstallLocator): void {
  writeMerged(file, installLocatorSchema, locator as unknown as Record<string, unknown>)
}

export function readKeptData(file: string): KeptData | null {
  return readValidated<KeptData>(file, keptDataSchema)
}

export function writeKeptData(file: string, kept: KeptData): void {
  writeJsonAtomic(file, keptDataSchema.parse(kept))
}
