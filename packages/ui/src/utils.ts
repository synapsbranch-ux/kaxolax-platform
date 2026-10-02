import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/** Espacements nommés de tokens.css (`h-bar`, `w-rail`, `px-gutter`…), connus de tailwind-merge. */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: ['bar', 'toolbar', 'tab', 'sidebar-footer', 'ask', 'rail', 'gutter'],
    },
  },
})

/** Fusionne des classes Tailwind (les dernières l'emportent en cas de conflit). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
