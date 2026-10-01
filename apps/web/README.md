# @kaxolax/web

Application Next.js (App Router, React, Tailwind, composants shadcn/ui de `@kaxolax/ui`) :
authentification Clerk, tableau de bord et éditeur. Le navigateur parle à Clerk (connexion), à
l'API (même origine : Next.js réécrit `/api/*` vers l'API en local) avec le jeton de session
Clerk dans `Authorization`, et au service temps réel (WebSocket, jeton de 5 minutes demandé à
l'API).

## Écrans

- **Compte (Clerk, en français)** : `/sign-in`, `/sign-up` (email et mot de passe, Google,
  GitHub), `/account` (profil, sécurité : MFA, sessions et appareils, suppression), menu du
  compte (`<UserButton />`). Les pages du groupe `(app)` exigent une session ; sans elle, retour
  sur `/sign-in?redirect_url=…`. Les clés Clerk sont lues à l'exécution (voir le README racine).
- 404, et `/healthz` (sonde publique).
- **Tableau de bord** : projets actifs, archivés et corbeille ; filtre par workspace (sélecteur
  minimal, « Tous les workspaces » par défaut) ; recherche ; tri par date ou par nom ; créer,
  renommer, archiver, mettre à la corbeille, restaurer, supprimer, importer un zip (dans le
  workspace choisi, sinon le workspace personnel).
- **Éditeur**, trois panneaux redimensionnables :
  - arborescence : créer, renommer, déplacer par glisser-déposer, supprimer, uploader plusieurs
    fichiers par glisser-déposer, définir le document principal, aperçu des images ;
  - CodeMirror 6 sur Yjs (`@kaxolax/editor`) : coloration LaTeX, rechercher/remplacer (Ctrl+F),
    repli, fermeture des accolades ;
  - PDF (pdf.js) : défilement continu, zoom, couche texte, téléchargement ; panneau de logs
    (erreurs et avertissements groupés, clic vers la bonne ligne, log brut, vider le cache).
- Barre de compilation : Recompiler (Ctrl+Entrée), Arrêter, compilateur, nombre d'erreurs,
  SyncTeX du code vers le PDF ; un double-clic dans le PDF place le curseur sur la ligne source.
  Le PDF de la dernière compilation s'affiche dès l'ouverture du projet.

## Développement

```bash
pnpm --filter @kaxolax/web dev        # http://localhost:3000 (l'API doit tourner sur :3333 ; clés Clerk dans .env)
pnpm --filter @kaxolax/web test       # Vitest (utilitaires)
```

## Parcours de la « Définition de terminé » (Playwright)

Il suppose toute la pile lancée : `docker compose up -d`, l'image TeX Live, puis `pnpm dev` à la
racine (API, temps réel, gateway, agent, web).

```bash
pnpm --filter @kaxolax/web exec playwright install chromium   # une fois
pnpm --filter @kaxolax/web e2e
```

Les parcours (`e2e/dod.spec.ts`, `e2e/auth.spec.ts`) créent leurs comptes par les composants Clerk
avec des adresses `+clerk_test` (code `424242`) : `CLERK_PUBLISHABLE_KEY` et `CLERK_SECRET_KEY`
de l'instance de développement sont exigées (jeton de test Clerk, `e2e/global-setup.ts`). Sur un
environnement déployé : `E2E_BASE_URL=https://… pnpm --filter @kaxolax/web e2e`.
