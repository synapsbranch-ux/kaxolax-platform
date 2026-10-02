import { userPreferencesSchema } from '@kaxolax/contracts'
import type { HttpContext } from '@adonisjs/core/http'
import { preferencesOf, updatePreferences } from '#services/preferences_service'
import { validateWithZod } from '#validators/zod'

export default class PreferencesController {
  /** Préférences complètes (valeurs par défaut appliquées), identiques sur tous les appareils. */
  async show({ auth }: HttpContext) {
    return { preferences: await preferencesOf(auth.getUserOrFail()) }
  }

  /** Modification partielle : fusion profonde, tableaux remplacés, clés inconnues refusées. */
  async update({ auth, request }: HttpContext) {
    const patch = validateWithZod(userPreferencesSchema, request.body())
    return { preferences: await updatePreferences(auth.getUserOrFail(), patch) }
  }
}
