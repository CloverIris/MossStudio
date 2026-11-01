export type MossInferArchitecture = 'standard' | 'sm75'
export type MossInferVariant = 'system-cuda' | 'bundled'

export function mossInferArchitectureForComputeCapability(
  major: number,
  minor: number,
): MossInferArchitecture | null {
  if (major === 7 && minor === 5) return 'sm75'
  if (major >= 8) return 'standard'
  return null
}

export function mossInferArchiveBase(
  version: string,
  os: 'linux' | 'windows',
  flavour: 'cu12' | 'cu13',
  variant: MossInferVariant,
  architecture: MossInferArchitecture,
): string {
  const target = architecture === 'sm75' ? '-sm75' : ''
  const cuda = variant === 'system-cuda' ? '-system-cuda' : ''
  return `mossinfer-${version}-${os}-${flavour}-x86_64${target}${cuda}`
}
