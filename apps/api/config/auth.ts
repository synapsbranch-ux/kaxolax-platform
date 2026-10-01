import { defineConfig } from '@adonisjs/auth'
import { sessionGuard, sessionUserProvider } from '@adonisjs/auth/session'
import type { Authenticators, InferAuthenticators, InferAuthEvents } from '@adonisjs/auth/types'
import { ClerkGuard } from '#auth/clerk_guard'
import clerkConfig from '#config/clerk'

const authConfig = defineConfig({
  default: 'clerk',
  guards: {
    /** Jeton de session Clerk (Authorization: Bearer), vérifié sans réseau. */
    clerk: {
      resolver: () =>
        Promise.resolve(
          (ctx) =>
            new ClerkGuard(ctx, {
              jwtKey: clerkConfig.jwtKey,
              authorizedParties: clerkConfig.authorizedParties,
            }),
        ),
    },
    /** Session de l'étape 1, acceptée seulement pendant la migration (AUTH_MODE session ou dual). */
    web: sessionGuard({
      useRememberMeTokens: false,
      provider: sessionUserProvider({ model: () => import('#models/user') }),
    }),
  },
})

export default authConfig

declare module '@adonisjs/auth/types' {
  export interface Authenticators extends InferAuthenticators<typeof authConfig> {}
}
declare module '@adonisjs/core/types' {
  interface EventsList extends InferAuthEvents<Authenticators> {}
}
