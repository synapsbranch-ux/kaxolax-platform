import { z } from 'zod'

export const compilerSchema = z.enum(['pdflatex', 'xelatex', 'lualatex'])
export type Compiler = z.infer<typeof compilerSchema>

export const compileStatusSchema = z.enum(['success', 'failure', 'timeout', 'error'])
export type CompileStatus = z.infer<typeof compileStatusSchema>

export const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { message: 'Expected a lowercase hex sha256' })

/** En-tête d'authentification entre services internes (secret partagé). */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token'

/** Longueur minimale exigée pour le secret partagé entre services. */
export const MIN_INTERNAL_TOKEN_LENGTH = 32
