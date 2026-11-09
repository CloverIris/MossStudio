/**
 * A model's name as the UI shows it: the base name and the variant words at
 * its end as tags ("MOSS-Image SFT" + INT8). `name` stays the whole plain text
 * for toasts, job names and older app versions. A name that does not end with
 * its variant words (an inconsistent remote catalog) is shown whole.
 */
export function nameParts(item: { name: string; variant?: readonly string[] }): { base: string; variant: string[] } {
  const variant = item.variant?.filter(Boolean) ?? []
  const suffix = variant.length ? ` ${variant.join(' ')}` : ''
  if (suffix && item.name.endsWith(suffix) && item.name.length > suffix.length) {
    return { base: item.name.slice(0, -suffix.length), variant }
  }
  return { base: item.name, variant: [] }
}
