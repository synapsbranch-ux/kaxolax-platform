import { z } from 'zod'

/**
 * Jetons d'accès personnels (serveur MCP, tâche 7) : routes du compte `/api/v1/me/tokens`. Le
 * secret n'est affiché qu'une fois, à la création ; l'API n'en garde que le hachage SHA-256 et un
 * préfixe affichable. Un jeton agit avec les droits de son propriétaire, restreints à ses portées
 * et, s'il le précise, à certains projets. Dates ISO 8601 en UTC.
 */

const isoDate = z.iso.datetime()

/** Début de tout secret (repérable par les scanners de secrets). */
export const PERSONAL_ACCESS_TOKEN_PREFIX = 'kxp_'
/** Jetons actifs (ni révoqués ni expirés) par compte. */
export const PERSONAL_ACCESS_TOKEN_MAX_ACTIVE = 20
/**
 * Créations par compte sur une fenêtre glissante (révoqués compris) : borne la boucle « créer,
 * révoquer, recréer ». Au-delà : 429 `E_TOKEN_RATE_LIMIT`.
 */
export const PERSONAL_ACCESS_TOKEN_MAX_CREATED = 50
export const PERSONAL_ACCESS_TOKEN_CREATION_WINDOW_DAYS = 30
/**
 * Un jeton révoqué ou expiré depuis plus longtemps est supprimé (à la création suivante) : la
 * liste reste bornée (actifs + créations récentes) sans pagination.
 */
export const PERSONAL_ACCESS_TOKEN_RETENTION_DAYS = 30
export const PERSONAL_ACCESS_TOKEN_NAME_MAX_LENGTH = 100
/** Projets nommés au plus par jeton (au-delà : tous les projets). */
export const PERSONAL_ACCESS_TOKEN_MAX_PROJECTS = 100
/** Durée de validité : obligatoire, au plus un an, 90 jours par défaut. */
export const PERSONAL_ACCESS_TOKEN_MAX_DAYS = 365
export const PERSONAL_ACCESS_TOKEN_DEFAULT_DAYS = 90

/**
 * Format d'un secret : `kxp_`, identifiant public de 12 caractères (alphanumériques), `_`, puis
 * 32 octets aléatoires en base64url (43 caractères).
 */
export const personalAccessTokenSecretSchema = z
  .string()
  .regex(/^kxp_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/, 'Malformed personal access token')

/** `read` : lire les projets ; `write` : les modifier aussi (suggestions, fichiers). */
export const TOKEN_SCOPES = ['read', 'write'] as const
export const tokenScopeSchema = z.enum(TOKEN_SCOPES)
export type TokenScope = z.infer<typeof tokenScopeSchema>

/** Vrai si les portées accordées couvrent celle demandée (`write` inclut `read`). */
export function tokenScopeAllows(scopes: readonly TokenScope[], needed: TokenScope): boolean {
  return scopes.includes(needed) || (needed === 'read' && scopes.includes('write'))
}

/** Codes d'erreur des jetons (`code` du corps de la réponse). */
export const TOKEN_ERRORS = {
  /** 404 : jeton inconnu pour ce compte. */
  notFound: 'E_TOKEN_NOT_FOUND',
  /** 409 : trop de jetons actifs (`PERSONAL_ACCESS_TOKEN_MAX_ACTIVE`). */
  limitReached: 'E_TOKEN_LIMIT',
  /** 429 : trop de créations récentes (`PERSONAL_ACCESS_TOKEN_MAX_CREATED`). */
  rateLimited: 'E_TOKEN_RATE_LIMIT',
  /** 422 : un projet nommé n'existe pas ou le compte n'en est pas membre. */
  invalidProject: 'E_TOKEN_INVALID_PROJECT',
} as const

/** `POST /me/tokens`. Réponse 201 : `createdPersonalAccessTokenResponseSchema`. */
export const createPersonalAccessTokenInputSchema = z.strictObject({
  name: z.string().trim().min(1, 'The name is empty').max(PERSONAL_ACCESS_TOKEN_NAME_MAX_LENGTH),
  scopes: z
    .array(tokenScopeSchema)
    .min(1)
    .max(TOKEN_SCOPES.length)
    .refine((scopes) => new Set(scopes).size === scopes.length, 'Duplicate scope'),
  /** Projets autorisés ; null ou absent : tous les projets dont le compte est membre. */
  projectIds: z
    .array(z.uuid())
    .min(1)
    .max(PERSONAL_ACCESS_TOKEN_MAX_PROJECTS)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate project')
    .nullable()
    .default(null),
  expiresInDays: z
    .number()
    .int()
    .min(1)
    .max(PERSONAL_ACCESS_TOKEN_MAX_DAYS)
    .default(PERSONAL_ACCESS_TOKEN_DEFAULT_DAYS),
})
export type CreatePersonalAccessTokenInput = z.infer<typeof createPersonalAccessTokenInputSchema>

/** Jeton tel que listé (jamais le secret ni son hachage). */
export const personalAccessTokenSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Début du secret (`kxp_` + identifiant public), pour le reconnaître. */
  prefix: z.string(),
  scopes: z.array(tokenScopeSchema),
  /** Null : tous les projets. */
  projectIds: z.array(z.uuid()).nullable(),
  expiresAt: isoDate,
  lastUsedAt: isoDate.nullable(),
  revokedAt: isoDate.nullable(),
  createdAt: isoDate,
})
export type PersonalAccessToken = z.infer<typeof personalAccessTokenSchema>

/**
 * `GET /me/tokens` : jetons du compte, du plus récent au plus ancien, révoqués et expirés compris
 * pendant `PERSONAL_ACCESS_TOKEN_RETENTION_DAYS` jours.
 */
export const personalAccessTokensResponseSchema = z.object({
  tokens: z.array(personalAccessTokenSchema),
})
export type PersonalAccessTokensResponse = z.infer<typeof personalAccessTokensResponseSchema>

/** Réponse de la création : le secret, affiché une seule fois. */
export const createdPersonalAccessTokenResponseSchema = z.object({
  token: personalAccessTokenSchema,
  secret: personalAccessTokenSecretSchema,
})
export type CreatedPersonalAccessTokenResponse = z.infer<
  typeof createdPersonalAccessTokenResponseSchema
>
