/*
|--------------------------------------------------------------------------
| Limitation de débit des routes sensibles
|--------------------------------------------------------------------------
*/
import limiter from '@adonisjs/limiter/services/main'
import { type HttpContext } from '@adonisjs/core/http'

function emailOf(ctx: HttpContext): string {
  const value: unknown = ctx.request.input('email')
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** Connexion : 5 essais par minute pour un même couple IP + email, 30 par minute par IP. */
export const loginThrottle = limiter.define('login', (ctx) =>
  limiter
    .allowRequests(5)
    .every('1 minute')
    .usingKey(`login:${ctx.request.ip()}:${emailOf(ctx)}`),
)

export const loginIpThrottle = limiter.define('login_ip', (ctx) =>
  limiter.allowRequests(30).every('1 minute').usingKey(`login_ip:${ctx.request.ip()}`),
)

/** Mot de passe oublié et renvoi de l'email de vérification : 3 demandes par 15 minutes. */
export const emailThrottle = limiter.define('email', (ctx) =>
  limiter
    .allowRequests(3)
    .every('15 minutes')
    .usingKey(`email:${ctx.request.ip()}:${emailOf(ctx)}`),
)

/** Inscription : 10 comptes par heure et par IP. */
export const registerThrottle = limiter.define('register', (ctx) =>
  limiter.allowRequests(10).every('1 hour').usingKey(`register:${ctx.request.ip()}`),
)
