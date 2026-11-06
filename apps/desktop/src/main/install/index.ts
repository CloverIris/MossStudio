/**
 * Install runtime, for the rest of main (the Updater in particular):
 *   getRunContext()        how this process runs: mode, R, launcher, install.json path and record
 *   confirmHealth()        set confirmed=true in install.json for the running version
 *   readInstallRecord / updateInstallRecord / writeInstallRecord, readLocator / writeLocator,
 *   writeJsonAtomic        atomic, schema-validated IO that keeps unknown keys
 */
export { getRunContext, type RunContext, type RunMode } from './runContext'
export { confirmHealth } from './app'
export {
  readInstallRecord,
  updateInstallRecord,
  writeInstallRecord,
  readLocator,
  writeLocator,
  writeJsonAtomic,
  readJsonObject,
} from './record'
export { APP_USER_MODEL_ID, appDirName, versionOfAppDir, launcherName, appExecutableName } from './layout'
