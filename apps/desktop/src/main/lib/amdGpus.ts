/**
 * AMD GPU facts on Linux, read from sysfs:
 * - `/sys/class/kfd/kfd/topology/nodes/<n>/properties`: one `key value` per
 *   line; GPU nodes have a non-zero `gfx_target_version` (major*10000 +
 *   minor*100 + stepping, e.g. 110000 = gfx1100, 120001 = gfx1201,
 *   90010 = gfx90a) and decimal `vendor_id` / `device_id`.
 * - `/sys/class/drm/card<n>/device/{vendor,device}`: hex PCI ids (`0x1002`).
 */

export interface KfdGpuNode {
  node: number
  gfxTarget: string
  vendorId: number
  deviceId: number
  pciId: string
}

export function parseKfdProperties(text: string): Map<string, number> {
  const values = new Map<string, number>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\w+)\s+(-?\d+)\s*$/.exec(line.trim())
    if (match) values.set(match[1]!, Number(match[2]))
  }
  return values
}

/** 110000 → gfx1100, 120001 → gfx1201, 90010 → gfx90a, 90402 → gfx942. */
export function gfxTargetName(version: number): string | null {
  if (!Number.isSafeInteger(version) || version <= 0) return null
  const major = Math.floor(version / 10000)
  const minor = Math.floor((version % 10000) / 100)
  const stepping = version % 100
  if (major <= 0 || minor > 15 || stepping > 15) return null
  return `gfx${major}${minor.toString(16)}${stepping.toString(16)}`
}

export function pciIdOf(vendorId: number, deviceId: number): string {
  return `${vendorId.toString(16).padStart(4, '0')}:${deviceId.toString(16).padStart(4, '0')}`
}

/** GPU nodes of the KFD topology (CPU nodes have gfx_target_version 0). */
export function kfdGpuNodes(nodes: Array<{ node: number; properties: string }>): KfdGpuNode[] {
  return nodes.flatMap(({ node, properties }) => {
    const values = parseKfdProperties(properties)
    const gfxTarget = gfxTargetName(values.get('gfx_target_version') ?? 0)
    if (!gfxTarget) return []
    const vendorId = values.get('vendor_id') ?? 0
    const deviceId = values.get('device_id') ?? 0
    return [{ node, gfxTarget, vendorId, deviceId, pciId: pciIdOf(vendorId, deviceId) }]
  }).sort((a, b) => a.node - b.node)
}

/** `0x1002` / `0x744c` from sysfs → `1002:744c`; null when either is not a hex id. */
export function drmPciId(vendor: string, device: string): string | null {
  const v = /^0x([0-9a-f]{1,4})$/i.exec(vendor.trim())
  const d = /^0x([0-9a-f]{1,4})$/i.exec(device.trim())
  if (!v || !d) return null
  return `${v[1]!.toLowerCase().padStart(4, '0')}:${d[1]!.toLowerCase().padStart(4, '0')}`
}

/** `ldconfig -p` output or a directory listing names ROCm 7's HIP runtime. */
export function hasRocm7Runtime(ldconfigOutput: string): boolean {
  return /\blibamdhip64\.so\.7\b/.test(ldconfigOutput)
}
