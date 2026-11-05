import { compareSemver, requiredUpdateMessage } from '@shared/update'
import { codedError } from '../lib/codedError'

let minimum: string | null = null
let current = ''

/** Set from the verified feed (or its verified cache) by the update runtime. */
export function setMinimumVersion(next: string | null, currentVersion: string): void {
  minimum = next
  current = currentVersion
}

export function updateRequired(): { required: boolean; minimumVersion: string | null } {
  const required = Boolean(minimum && current && compareSemver(current, minimum) < 0)
  return { required, minimumVersion: minimum }
}

/** The one check in the generation start path: refuse while current < minimumVersion. */
export function assertGenerationAllowed(): void {
  const { required, minimumVersion } = updateRequired()
  if (required && minimumVersion) throw codedError('E_UPDATE_REQUIRED', requiredUpdateMessage(minimumVersion))
}
