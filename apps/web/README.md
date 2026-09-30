# @kaxolax/web

Application Next.js (App Router, React, Tailwind, composants shadcn/ui de `@kaxolax/ui`) :
authentification, tableau de bord et éditeur. Le navigateur ne parle qu'à l'API (même origine :
Next.js réécrit `/api/*` vers l'API en local, CloudFront route `/api/*` en staging) et au service
temps réel (WebSocket, jeton de 5 minutes demandé à l'API).

## Écrans

- Inscription, connexion, confirmation de l'email, mot de passe oublié, réinitialisation, 404.
- **Tableau de bord** : projets actifs, archivés et corbeille ; recherche ; tri par date ou par
  nom ; créer, renommer, archiver, mettre à la corbeille, restaurer, supprimer, importer un zip.
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
pnpm --filter @kaxolax/web dev        # http://localhost:3000 (l'API doit tourner sur :3333)
pnpm --filter @kaxolax/web test       # Vitest (utilitaires)
```

## Parcours de la « Définition de terminé » (Playwright)

Il suppose toute la pile lancée : `docker compose up -d`, l'image TeX Live, puis `pnpm dev` à la
racine (API, temps réel, gateway, agent, web).

```bash
pnpm --filter @kaxolax/web exec playwright install chromium   # une fois
pnpm --filter @kaxolax/web e2e
```

Sur staging, les emails de test sont reçus par SES et lus dans S3 (identifiants AWS de la chaîne
par défaut du SDK) ; les trois valeurs sont des sorties Terraform de kaxolax-infra. La CI de `main`
lance ce parcours après chaque déploiement quand ces variables du dépôt sont posées.

```bash
E2E_BASE_URL=https://….cloudfront.net E2E_MAIL_DOMAIN=e2e-mail.<domaine> \
E2E_MAIL_S3_BUCKET=kaxolax-staging-e2e-mail-<compte> pnpm --filter @kaxolax/web e2e
```

L'inscription est limitée à 10 par heure et par adresse IP : pour relancer souvent le parcours en
local, vider les compteurs (`docker compose exec redis sh -c "redis-cli --scan --pattern 'kaxolax:rlflx*' | xargs -r redis-cli del"`).
