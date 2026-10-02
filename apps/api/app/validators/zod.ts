import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'

/** Ce que l'API utilise d'un problème zod (évite une dépendance directe à zod). */
interface SchemaIssue {
  path: PropertyKey[]
  message: string
  code: string
}

/** Schéma zod de @kaxolax/contracts, vu par sa seule méthode `safeParse`. */
interface SafeParseSchema<T> {
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: SchemaIssue[] } }
}

/**
 * Données refusées par un schéma zod de @kaxolax/contracts : 422, avec la même forme que les
 * erreurs VineJS (`errors[]` : champ, message, règle).
 */
export class ZodValidationException extends Exception {
  static override status = 422
  static override code = 'E_VALIDATION_ERROR'
  static override message = 'Validation failure'

  constructor(readonly issues: SchemaIssue[]) {
    super()
  }

  async handle(error: this, ctx: HttpContext) {
    ctx.response.status(error.status).send({
      code: error.code,
      message: error.message,
      errors: error.issues.map((issue) => ({
        field: issue.path.map(String).join('.'),
        message: issue.message,
        rule: issue.code,
      })),
    })
    return Promise.resolve()
  }
}

/** Valide `data` avec un schéma zod partagé ; lève `ZodValidationException` (422) sinon. */
export function validateWithZod<T>(schema: SafeParseSchema<T>, data: unknown): T {
  const result = schema.safeParse(data)
  if (!result.success) throw new ZodValidationException(result.error.issues)
  return result.data
}
