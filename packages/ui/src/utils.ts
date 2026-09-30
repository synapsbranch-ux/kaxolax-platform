import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Fusionne des classes Tailwind (les dernières l'emportent en cas de conflit). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
