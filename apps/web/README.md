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
  du pied de sidebar, « Tous les workspaces » par défaut, préselection par `?workspace=`) ;
  recherche ; tri par date ou par nom ; créer, renommer, archiver, mettre à la corbeille,
  restaurer, supprimer, importer un zip (dans le workspace choisi, sinon le workspace
  personnel). Sidebar sombre comme la page projet, barre du haut sous 768 px.
- **Projet** (`components/workspace/`), thème sombre pour la sidebar et l'éditeur, zone PDF
  toujours claire ; trois colonnes redimensionnables, sidebar repliable (tailles et repli
  mémorisés dans les préférences) ; sous 1024 px, sidebar en tiroir et éditeur/PDF en onglets.
  - Sidebar : logo, sélecteur de projet (récents, recherche, nouveau projet, tableau de bord),
    emplacements présence et partage, onglets Fichiers (arborescence : créer, renommer, déplacer
    par glisser-déposer, supprimer, uploader, document principal) et Chats (à venir), menu +,
    recherche dans tout le projet (loupe ou Ctrl+Maj+F : casse, mot entier, expression
    régulière, résultats par fichier), section Plan (document courant et fichiers inclus,
    section courante surlignée), pied (utilisateur, workspace, `<UserButton />`).
  - Éditeur : onglets des fichiers ouverts (mémorisés par projet), bouton + (ouvrir ou créer),
    bouton Outils (barre de menus du registre d'actions de `@kaxolax/editor`), CodeMirror 6 sur
    Yjs en thème sombre, aperçu des images, emplacements Review, Historique et assistant
    (étape 3). Les outils s'ajoutent par `useEditorActions()` (registre partagé, raccourcis) et
    `ACTION_DIALOGS` (`workspace/action-dialogs.tsx`).
  - PDF (pdf.js) : pastille de statut (Recompiler, Ctrl+Entrée) et son menu (auto-compilation,
    compilateur, brouillon, arrêt à la première erreur, arrêt, vider le cache, logs), zoom
    (page, largeur, 50 à 400 %), téléchargement, menu ⋯ (zip des sources, fichiers de sortie,
    nouvel onglet, impression), tiroir des logs (erreurs cliquables, log brut), barre flottante (annuler,
    pages, « Aller au PDF » par SyncTeX) ; un double-clic dans le PDF place le curseur sur la
    ligne source. Le PDF de la dernière compilation s'affiche dès l'ouverture du projet.
  - États : squelettes pendant le chargement, page d'erreur (nouvel essai) si le projet ne se
    charge pas, « Projet introuvable » (404), message si le service temps réel refuse la
    connexion ; côté PDF : « Chargement de l'aperçu PDF… », projet jamais compilé, échec ou
    délai dépassé avec lien vers les logs.
  - Clavier : Ctrl+Entrée (compiler), Ctrl+Maj+F (recherche projet), raccourcis du registre
    d'actions ; arborescence (flèches, Entrée, F2 renommer, Suppr, Maj+F10 menu), onglets des
    fichiers (flèches, Suppr ferme), barre Outils (Menubar Radix : flèches entre les menus).
    Sidebar repliée : inerte (hors de l'ordre de tabulation).
- **Préférences** (`components/preferences/`) : `usePreferences()` charge `GET /me/preferences`
  une fois (layout `(app)`) et enregistre les modifications par `PATCH` (optimiste, regroupé
  800 ms, envoyé aussitôt quand la page est masquée). Clés utilisées : `theme` (bascule
  soleil/lune du pied de sidebar ; paramètres complets à la tâche 10), `layout` (tailles des
  colonnes, repli), `toolsVisible`, `autoCompile`, `compile` (brouillon, arrêt à la première
  erreur), `openTabs` (onglets par projet). Le thème est recopié dans le cookie `kaxolax-theme`
  (rendu serveur de `data-theme`, sans flash) et dans localStorage (`ThemeScript`).

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
