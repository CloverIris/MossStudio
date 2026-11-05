import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { buildE2eApp } from './build.mts'

declare module 'vitest' {
  export interface ProvidedContext {
    e2eAppDir: string
  }
}

/** One renderer build per run, shared by every spec file. */
export default async function setup(project: TestProject): Promise<() => void> {
  const outDir = process.env['E2E_APP_DIR'] ?? mkdtempSync(join(tmpdir(), 'mossstudio-e2e-app-'))
  if (!process.env['E2E_SKIP_BUILD']) await buildE2eApp(outDir)
  project.provide('e2eAppDir', outDir)
  return () => {
    if (!process.env['E2E_APP_DIR']) rmSync(outDir, { recursive: true, force: true })
  }
}
