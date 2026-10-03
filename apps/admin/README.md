# @kaxolax/admin

Admin minimal de Kaxolax : application Next.js séparée (App Router, React, Tailwind, composants
de `@kaxolax/ui`, Clerk), servie sur son propre domaine. Thème sombre, interface en français.
Toutes les données passent par l'API (`/api/v1/admin/*`), qui revérifie l'accès à chaque appel ;
l'admin ne lit jamais la base ni le contenu des projets.

## Accès

Réservée aux comptes Clerk qui ont :

- le rôle admin : public metadata `{"role": "admin"}` (Dashboard Clerk → Users → Metadata),
  présente dans le jeton de session par le claim `metadata` (voir le README racine) ;
- la MFA activée, et un second facteur vérifié pendant la session (claim `fva`).

Contrôles, du plus tôt au plus sûr :

1. le layout serveur du groupe `(admin)` exige une session (sinon `/sign-in`), puis le rôle et
   le second facteur dans les claims ; sinon une page « Accès refusé » qui ne dit pas pourquoi ;
2. l'API (`middleware.admin()`) refait ces vérifications sur le jeton, puis confirme par l'API
   Backend de Clerk que le compte est toujours admin et a `twoFactorEnabled` (cache 60 s). Un
   refus (403) s'affiche comme « Accès refusé ».

Un admin dont la session a été ouverte sans second facteur doit se déconnecter puis se
reconnecter en validant la MFA. L'admin n'a pas d'inscription (`/sign-in` seulement).

## Écrans

- **Utilisateurs** (`/users`) : recherche par email, nom ou id (local ou Clerk), liste paginée ;
  fiche (plan et limites, inscription, dernière connexion et activité lues chez Clerk, MFA,
  projets possédés et partagés, stockage) ; bannir, débannir, révoquer toutes les sessions,
  supprimer le compte (confirmation, email à recopier pour la suppression).
- **Organisations** (`/organizations`) : workspaces d'équipe (miroir des Organisations Clerk),
  recherche par nom, slug ou id `org_…` ; plan d'organisation et état de l'abonnement, membres et
  administrateurs, projets, stockage mutualisé, responsable ; fiche (`/organizations/<org_…>`)
  avec les membres (rôles d'après Clerk) et les projets (métadonnées). Lecture seule : les équipes
  se gèrent dans le Dashboard Clerk.
- **Projets** (`/projects`) : recherche par nom, propriétaire (email ou id) ou id, filtre
  Tous / Actifs / Archivés / Corbeille ; fiche de métadonnées (taille, fichiers, documents,
  membres, dernière compilation) ; transférer la propriété (recherche du destinataire), archiver,
  désarchiver, mettre à la corbeille, restaurer, supprimer définitivement (depuis la corbeille,
  nom à recopier).
- **Bannière système** (`/banners`) : liste (programmée, affichée, terminée), création,
  modification avec aperçu, niveaux information / avertissement / maintenance, début et fin
  facultatifs (heure locale du navigateur), terminer maintenant (heure du serveur), supprimer.
- **Statistiques** (`/stats?days=7|30|90|365`) : inscriptions (total et histogramme par jour),
  utilisateurs actifs sur 7 et 30 jours, abonnés Pro et abonnements par plan, compilations
  terminées (volume, durée moyenne, taux d'échec, répartition par résultat et par agent) ; les
  compilations annulées sont comptées à part (hors total, durée et taux), celles encore en cours
  ne comptent pas (`lib/stats.ts`). Graphiques en SVG et CSS, sans bibliothèque.
- **Journal** (`/audit-log`) : actions de l'admin (auteur, action, cible, résultat, détails),
  filtres par action, type et id de cible, résultat, auteur et période.

## En-têtes de sécurité et CSP

`src/lib/security-headers.ts` (testé dans `security-headers.test.ts`) :

- CSP stricte sur chaque page, posée par le proxy (`src/proxy.ts`) avec l'option
  `contentSecurityPolicy` de `clerkMiddleware` : nonce par requête (Next.js l'applique à ses
  scripts, le layout racine le passe à `ClerkProvider`) et `'strict-dynamic'` ; origines de
  Clerk (Frontend API de l'instance, `img.clerk.com`, Turnstile, workers `blob:`) ajoutées par
  Clerk, `'unsafe-eval'` en développement seulement. L'admin ajoute `connect-src 'self'` (tout
  passe par `/api`), `img-src 'self' data:`, `font-src 'self' data:`, `object-src 'none'`,
  `base-uri 'self'`, `form-action 'self'` et `frame-ancestors 'none'`. Styles `'unsafe-inline'`
  (Clerk, attributs `style` de React). zod est réglé sans compilation de ses validateurs dans le
  navigateur (`src/instrumentation-client.ts`) : aucune violation de la CSP.
- En-têtes fixes de toutes les réponses (`next.config.ts`) : `X-Robots-Tag: noindex, nofollow`,
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy` (caméra, micro, géolocalisation, USB, série, HID et paiement refusés).

## Variables (`apps/admin/.env`, lues à l'exécution sauf `API_INTERNAL_URL`)

| Variable                | Rôle                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| `API_INTERNAL_URL`      | API vue par le serveur Next.js (réécriture de `/api`), lue au build |
| `CLERK_PUBLISHABLE_KEY` | même instance Clerk que `apps/web`                                  |
| `CLERK_SECRET_KEY`      | idem                                                                |
| `CLERK_JWT_KEY`         | clé publique PEM sur une ligne avec des `\n` (sessions sans réseau) |

Côté API : `ADMIN_URL` (origine de l'admin, acceptée dans le claim `azp`) et `CLERK_SECRET_KEY`
(API Backend de Clerk : vérification de la MFA, actions sur les comptes).

Domaine : un sous-domaine du domaine principal de l'instance Clerk de production (par exemple
`admin.<domaine>`) partage la session sans configuration « satellite ».

## Développement

```bash
pnpm --filter @kaxolax/admin dev    # http://localhost:3001 (l'API doit tourner sur :3333)
pnpm --filter @kaxolax/admin test   # Vitest (contrôle des claims, formats, statistiques, CSP)
```

Image : `docker build -f docker/Dockerfile --target admin .` (Next.js `standalone`, port 3001).
Production : service Railway `admin` (`deploy/railway/admin.json`, `KAXOLAX_SERVICE=admin`,
`PORT=3001`), domaine `admin.<domaine>` ; variables dans `deploy/railway/README.md`.
