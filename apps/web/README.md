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
- **Bannière système** (`components/system-banner.tsx`) : annonces publiées depuis l'admin, sur
  toutes les pages connectées, en bandeau fixe en haut de l'écran (aucune hauteur ajoutée à
  l'éditeur plein écran ; la nouvelle interface de la tâche 3 pourra leur réserver une place),
  couleur selon le niveau, fermables pour la session jusqu'à leur prochaine modification ;
  reçues en direct sur la page projet (événement `banner.changed` du document meta, relayé par
  `bannerFeed` de `lib/project-events.ts`), et `GET /api/v1/banners/active` relu toutes les 60 s
  et au retour sur l'onglet en filet (tableau de bord, connexion temps réel coupée).
- **Invitation et lien de partage** (pages publiques `/invitations/[token]` et `/share/[token]`,
  `components/sharing/join-page.tsx`) : aperçu sans compte (projet, rôle, invitant, échéance),
  puis « Accepter » ou « Rejoindre » une fois connecté et redirection vers le projet. Sans
  session : « Se connecter » ou « Créer un compte » (Clerk, `redirect_url` qui ramène sur la
  page). Une invitation déjà acceptée automatiquement à l'inscription est réglée sans clic
  (acceptation idempotente). Erreurs traduites (`lib/sharing.ts`) : invitation annulée ou
  expirée, autre adresse (indice `a***@…` et « Changer de compte »), limite du plan.
- **Tableau de bord** : projets actifs, archivés et corbeille ; filtre par workspace (sélecteur
  du pied de sidebar, « Tous les workspaces » par défaut, préselection par `?workspace=`) ;
  recherche ; tri par date ou par nom ; créer, renommer, archiver, mettre à la corbeille,
  restaurer, supprimer, importer un zip (dans le workspace choisi, sinon le workspace
  personnel). Sidebar sombre comme la page projet, barre du haut sous 768 px.
- **Projet** (`components/workspace/`), thème sombre pour la sidebar et l'éditeur, zone PDF
  toujours claire ; trois colonnes redimensionnables, sidebar repliable (tailles et repli
  mémorisés dans les préférences) ; sous 1024 px, sidebar en tiroir et éditeur/PDF en onglets.
  - Sidebar : logo, sélecteur de projet (récents, recherche, nouveau projet, tableau de bord),
    présence et partage (voir plus bas), onglets Fichiers (arborescence : créer, renommer, déplacer
    par glisser-déposer, supprimer, uploader, document principal) et Chats (voir plus bas), menu +,
    recherche dans tout le projet (loupe ou Ctrl+Maj+F : casse, mot entier, expression
    régulière, résultats par fichier), section Plan (document courant et fichiers inclus,
    section courante surlignée), pied (utilisateur, workspace, `<UserButton />`).
  - Éditeur : onglets des fichiers ouverts (mémorisés par projet), bouton + (ouvrir ou créer),
    bouton Outils (barre de menus du registre d'actions de `@kaxolax/editor`), CodeMirror 6 sur
    Yjs en thème sombre, aperçu des images, panneau Review (voir plus bas), emplacement
    de l'assistant (étape 3), tiroir Historique (voir plus bas). Les outils s'ajoutent par `useEditorActions()` (registre partagé, raccourcis) et
    `ACTION_DIALOGS` (`workspace/action-dialogs.tsx`).
  - PDF (pdf.js) : pastille de statut (Recompiler, Ctrl+Entrée) et son menu (auto-compilation,
    compilateur, brouillon, arrêt à la première erreur, arrêt, vider le cache, logs), zoom
    (page, largeur, 50 à 400 %), téléchargement, menu ⋯ (zip des sources, fichiers de sortie,
    nouvel onglet, impression), tiroir des logs (erreurs cliquables, log brut), barre flottante (annuler,
    pages, « Aller au PDF » par SyncTeX) ; un double-clic dans le PDF place le curseur sur la
    ligne source. Le PDF de la dernière compilation s'affiche dès l'ouverture du projet.
  - Temps réel du projet (`workspace/use-project-meta.ts`) : à l'ouverture, connexion au
    document meta `project:{id}:meta` sur le WebSocket partagé. La page y publie sa présence
    (identité, fichier de l'onglet actif) et reçoit les événements sans état :
    `tree.changed` (arborescence relue sans recharger, une fois par rafale de 150 ms),
    `member.*` (modale de partage ouverte relue ; son propre retrait ou changement de rôle :
    projet relu), `banner.changed` (bannière), et le message `member.role-changed` de sa
    connexion (bascule lecture seule ou écriture, avec un message). Retrait du projet
    (connexion fermée « Forbidden », événement ou projet en 404) : page « Vous n'avez plus accès
    à ce projet », puis retour au tableau de bord après 6 s.
  - Présence (`lib/presence.ts`, états validés par `parsePresenceState`) : pile d'avatars des
    autres personnes en ligne dans la sidebar (`PresenceStack`, `AvatarStack` de
    `@kaxolax/ui`, photo de profil sinon initiales, couleur dérivée de l'id ; plusieurs onglets d'une personne regroupés ; au
    survol, le ou les fichiers ouverts), pastilles de couleur à côté des fichiers de
    l'arborescence ouverts par d'autres, curseurs et sélections des collaborateurs dans
    l'éditeur avec leur nom toujours visible (y-codemirror.next, `collaboratorCursorTheme` de
    `@kaxolax/editor`). Clic sur un avatar : suivre la personne (son fichier s'ouvre, l'éditeur
    défile jusqu'à son curseur et la suit d'un fichier à l'autre) jusqu'à la prochaine frappe
    dans l'éditeur ; bandeau « Vous suivez X » avec « Arrêter de suivre » ; suivi arrêté si la
    personne reste absente 3 s (une reconnexion du WebSocket ne l'arrête pas). Arborescence
    relue : seule la réponse de la dernière demande s'applique. Connexion meta refusée (jeton non
    obtenu, erreur du serveur) : accès revérifié, puis connexion rouverte s'il est confirmé
    (délai de 2 s doublé à chaque échec, 30 s au plus).
  - Chat du projet (onglet Chats, `sidebar/chats-panel.tsx`, `workspace/use-project-chat.ts`,
    logique dans `lib/chat.ts`) : 50 derniers messages au chargement, plus anciens au défilement
    vers le haut (position conservée) ; à chaque `chat.message-created` (relayé par `chatFeed`)
    et au retour sur l'onglet, messages suivants relus par curseur `after`. Badge de non-lus sur
    l'onglet lu depuis l'API (exact après rechargement) ; messages marqués comme lus seulement si
    le chat est sous les yeux (sidebar dépliée ou tiroir ouvert, onglet Chats, page visible).
    L'état du chat et l'onglet sont tenus par la page (le tiroir d'un écran étroit se démonte) ;
    sidebar masquée : pastille de non-lus sur le bouton qui l'affiche. Texte brut uniquement (aucun HTML interprété), regroupé par jour puis par
    auteur (5 min). `@` propose les membres (flèches, Entrée ou Tab) ; à l'envoi, `@Nom` devient
    `<@uuid>`. `chemin.tex:42` devient un lien qui ouvre le fichier à la ligne, seulement si le
    document existe (chemin exact, ou nom seul s'il est unique). `?panel=chat` ouvre le chat
    (lien de l'email de mention), sidebar dépliée ou tiroir ouvert. Entrée envoie, Maj+Entrée va à la ligne ; 429 : délai affiché.
  - Commentaires et panneau Review (`panels/review-panel.tsx`, `panels/comment-composer.tsx`,
    `workspace/use-project-comments.ts`, logique dans `lib/comments.ts`) : fils du projet
    chargés à l'ouverture, fil concerné relu à chaque `comment.created` ou
    `comment.thread-updated` (relayés par `commentFeed`), tout relu au retour sur l'onglet.
    Owner, editor et reviewer sélectionnent du texte puis « Commenter la sélection »
    (Ctrl+Alt+M) : l'ancre est créée sur le Y.Doc ouvert (`createCommentAnchor`, début et fin en
    positions relatives) avec la citation (1000 caractères au plus). L'éditeur résout les ancres
    après chaque modification et surligne le texte des fils ouverts (`commentHighlights` de
    `@kaxolax/editor`) ; un clic dans un texte commenté ouvre son fil. Panneau : onglets
    Ouverts / Résolus, fils du document actif dans l'ordre du texte puis des autres documents,
    précédent / suivant (en boucle), clic sur un fil → saut au texte (document ouvert au besoin) ;
    texte ancré supprimé : citation barrée et « Texte commenté supprimé ». Réponses, modification
    et suppression de ses messages, résolution et réouverture ; `@` propose les membres (comme le
    chat). Lecteur : lecture seule. `?comment=<id>` (lien de l'email de mention) ouvre le fil.
  - Historique (`panels/history-drawer.tsx`, `workspace/use-project-history.ts`, logique dans
    `lib/history.ts`), bouton Historique de la colonne éditeur : versions groupées par jour
    (heure, nature, label, auteurs dans leur couleur de présence), relues à chaque
    `version.created` (relayé par `historyFeed`). Une version ouvre ses fichiers changés (ou tous),
    le diff d'un document coloré par auteur (ajouts surlignés, suppressions barrées, passages
    inchangés repliés, légende +/− par auteur) et l'aperçu d'une image. Owner et editor nomment
    une version et restaurent le projet ou un fichier, après confirmation (le dialogue cite ce
    qui sera retiré ou remplacé et le nombre de fils de commentaires perdus) ; zip d'une version
    par lien court. Erreurs de l'API traduites en français par code (`historyErrorMessage`,
    `commentErrorMessage`, `chatErrorMessage`, `localizedErrorMessage` dans `lib/api.ts`). Le
    panneau Review masque les fils d'un document absent de l'arborescence et relit les fils quand
    les documents changent (suppression, restauration). L'auto-compilation envoie `trigger: 'auto'` (pas de version).
  - Lecture seule : passer en lecture seule reconfigure l'éditeur sans le recréer ; le retour en
    écriture rouvre le document (les frappes refusées pendant la lecture seule bloqueraient les
    suivantes).
  - Partage (bouton personne +, `components/sharing/`) : propriétaire : inviter par email avec
    un rôle (éditeur, relecteur, lecteur ; usage de la limite du plan affiché), membres (changer
    le rôle, retirer, transférer la propriété, avec confirmation), invitations en attente
    (échéance, relancer une fois par minute, annuler), liens de partage lecture seule et édition
    (activer, désactiver, copier, régénérer avec confirmation). `E_PLAN_LIMIT` : la limite et un
    lien vers les tarifs (`PRICING_URL`, page de la tâche 12). Autres rôles : vue limitée (membres
    et rôles, « Quitter » le projet). Réponses validées par les schémas zod des contrats.
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
