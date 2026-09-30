# @kaxolax/api

API REST de Kaxolax (AdonisJS 7, Lucid, VineJS), sous `/api/v1`. Le navigateur l'appelle par la
même origine que l'application (rewrites Next.js en local, CloudFront en staging) : pas de CORS.

## Fonctionnalités (étape 1)

- **Comptes** :
  - sessions dans Redis, cookie `kaxolax-session` httpOnly ;
  - protection CSRF de Shield (le navigateur renvoie le cookie `XSRF-TOKEN` dans l'en-tête `X-XSRF-TOKEN`) ;
  - vérification de l'email obligatoire avant la connexion ;
  - mot de passe oublié par lien à usage unique ; seul le hash des jetons est stocké ;
  - limitation de débit sur la connexion, l'inscription, le renvoi de vérification et le mot de passe oublié.
- **Projets** : liste (`view` = active, archived, trashed ; `q`), création avec un `main.tex`
  minimal qui compile, renommage, compilateur, document principal, archive, corbeille,
  suppression depuis la corbeille.
- **Arborescence** : dossiers et documents texte (état Yjs dès l'étape 1), renommage,
  déplacement, suppression récursive. Chemins calculés, jamais stockés. Noms uniques dans un
  dossier, tous types confondus, vérifiés en transaction avec le projet verrouillé.
- **Accès** : toujours par `project_members`. Un projet dont l'utilisateur n'est pas membre
  répond 404. Rôles : owner > editor > reviewer > viewer.
- **Temps réel** : `POST /projects/:id/realtime-token` signe un jeton de 5 minutes pour le
  service `apps/realtime` (`REALTIME_TOKEN_SECRET`, `REALTIME_PUBLIC_URL`). À la suppression
  d'un document, d'un dossier ou d'un projet, l'API demande au service de fermer les connexions
  ouvertes (`REALTIME_INTERNAL_URL`, `INTERNAL_TOKEN`), au mieux et avec un délai de 2 s.

Les uploads, l'import zip, la compilation, SyncTeX et l'export arrivent avec les tâches
suivantes.

## Développement

Prérequis : la stack locale (`docker compose up -d` à la racine).

```bash
pnpm --filter @kaxolax/api migrate   # applique les migrations (crée .env depuis .env.example au besoin)
pnpm --filter @kaxolax/api dev       # http://localhost:3333/api/v1/health
```

Les emails arrivent dans Mailpit : http://localhost:8025.

## Tests

```bash
pnpm --filter @kaxolax/api test      # Japa : unitaires + fonctionnels (base kaxolax_test)
```

Les tests fonctionnels couvrent chaque endpoint, y compris les refus : projet d'un autre
utilisateur, nom en double, nom invalide, rôle insuffisant, jeton expiré ou réutilisé, CSRF
manquant, limitation de débit. Un test vérifie aussi que deux créations simultanées du même nom
ne réussissent jamais toutes les deux.
