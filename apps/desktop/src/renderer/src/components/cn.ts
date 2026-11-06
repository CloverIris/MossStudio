import { extendTailwindMerge } from 'tailwind-merge'

/**
 * This theme's own tokens (styles.css `@theme`). tailwind-merge has to know
 * them: without the list it reads `text-caption` as a colour and drops it when
 * a `text-ink-2` follows.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      // `--text-*` in @theme: font sizes.
      text: ['micro', 'caption', 'ui', 'control', 'section', 'title', 'display'],
      // `--color-*` in @theme. (`--text-primary/secondary/tertiary` in :root are legacy colour aliases.)
      color: [
        'frame',
        'board',
        'panel',
        'surface',
        'raised',
        'well',
        'well-strong',
        'ink',
        'ink-2',
        'ink-3',
        'on-ink',
        'accent',
        'accent-soft',
        'on-accent',
        'ok',
        'warn',
        'danger',
        'ok-soft',
        'warn-soft',
        'danger-soft',
        'primary',
        'secondary',
        'tertiary',
      ],
      radius: ['control', 'card', 'dialog'],
      shadow: ['float'],
    },
  },
})

/** Joins class names; a later class wins over an earlier one for the same property. */
export function cn(...values: Array<string | false | null | undefined>): string {
  return twMerge(values)
}
