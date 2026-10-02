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
- **Abonnements (Clerk Billing)** : `/pricing` (publique) avec `<PricingTable />`, liée depuis le
  menu du compte (`components/billing/account-menu.tsx`) ; abonnement, factures et moyens de
  paiement dans l'onglet Billing de `/account`. `has({ plan })` ne sert qu'à l'affichage. Les
  refus 403 `E_PLAN_LIMIT` de l'API s'expliquent dans `PlanLimitNotice`
  (`components/billing/plan-limit-notice.tsx`, message, limite, bouton vers les tarifs) : en
  ligne dans le résultat d'une compilation en délai dépassé, sinon dans une boîte de dialogue
  commune (`PlanLimitDialog`, layout `(app)`) pour tout appel de l'API ; un écran qui affiche le
  refus lui-même (modale de partage) appelle `markPlanLimitHandled(error)` dans son `catch` et
  passe `error.planLimit` au composant.
- 404, et `/healthz` (sonde publique).
- **Galerie de templates** (`components/templates/`) : `/templates` (publique, rendue par le
  serveur depuis `GET /api/v1/templates`) avec recherche (sans accents, même fonction
  `filterTemplates` que l'API, appliquée dans le navigateur), catégories avec compteurs (CV,
  Thèse, Article, Présentation Beamer, Lettre, Rapport) et cartes avec miniature ; fiche
  `/templates/[id]` : aperçu PDF (la visionneuse pdf.js de l'éditeur, zone claire), compilateur,
  langue, licence, mots-clés, et « Utiliser ce template » (nom du projet, titre par défaut, puis
  `POST /api/v1/projects/from-template` et ouverture de l'éditeur). Sans session : connexion
  Clerk avec retour sur `/templates/[id]?use=1`, où la boîte de dialogue se rouvre. Tableau de
  bord : « Depuis un template » (sidebar, barre étroite, tableau de bord vide) ouvre la même
  galerie dans une boîte de dialogue et crée le projet dans le workspace affiché. Miniatures et
  PDF viennent directement du domaine public R2 du catalogue (URL fournies par l'API) :
  miniatures par `next/image` en `unoptimized` (déjà à 600 px, aucun `remotePatterns` à figer au
  build) ; l'aperçu pdf.js lit le PDF par `fetch`, ce qui exige une règle CORS du bucket
  (`GET`/`HEAD` depuis l'origine de l'application, en-tête `Range`) ; sinon la fiche garde le
  message d'erreur et un lien « Ouvrir le PDF ». Le refus `E_PLAN_LIMIT` (stockage) s'affiche
  dans la boîte de dialogue.
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
    Yjs en thème sombre, aperçu des images, panneau Review (voir plus bas), emplacement de
    l'assistant (étape 3), tiroir Historique (voir plus bas). Les outils s'ajoutent par
    `useEditorActions()` (registre partagé, raccourcis) et `ACTION_DIALOGS`
    (`workspace/action-dialogs.tsx`, boîtes chargées à la demande).
  - Outils d'écriture (`workspace/writing/`, logique dans `@kaxolax/editor`, désactivés en
    lecture seule) : **éditeur de formules** (Maths, Ctrl+Maj+E : champ MathLive chargé à la
    première ouverture, LaTeX éditable en texte brut, bibliothèque, en ligne / centrée / numérotée
    avec label, aperçu du texte inséré ; ouvert sur la formule sous le curseur, il la remplace
    exactement) ; **symboles** (Maths : onglets par catégorie, recherche, récents mémorisés dans
    les préférences, flèches dans la palette, package manquant ajouté en un clic ou à
    l'insertion) ; **tableau** (Structures : grille au clavier — flèches, Tab, Entrée,
    Alt+Maj+flèches pour sélectionner —, lignes et colonnes, fusion `\multicolumn`/`\multirow`,
    alignement, filets booktabs/classiques/verticaux, collage depuis un tableur ou un CSV, légende
    et label, aperçu du code ; ouvert sur le tableau sous le curseur, texte brut s'il n'est pas
    représentable ; insertion refusée tant qu'une case ou la légende ne compilerait pas, avec
    échappement en un clic ; pas de flottant `table` dans une figure ou une minipage). Formule
    tapée en LaTeX : insertion refusée si elle ne compilerait pas (accolades, `$`, `&`…). Un
    outil qui ne se charge pas (hors ligne, nouvelle version) ou qui échoue affiche « Outil
    indisponible » (Réessayer, Fermer) sans fermer l'éditeur. Packages requis ajoutés au préambule dans la même étape d'annulation ; dans
    un fichier sans préambule, rappel à charger dans le document principal. MathLive n'utilise
    aucune ressource externe (polices servies par Next.js, sons coupés) ; ses extensions HTML
    (`\href`, `\htmlStyle`…) sont retirées des valeurs chargées et aucun lien n'est ouvert.
  - Outils de la tâche 10 (`workspace/tools/`, `workspace/spellcheck/`) :
    - **Gestionnaire de packages** (Packages → Gestionnaire de packages) : recherche dans l'index
      TeX Live de l'API (`GET /texlive/packages`, pages de 20), fiche (description, catégorie,
      sujets, licence, liens CTAN et documentation), ajout d'un `\usepackage` avec options
      (aperçu de la commande, options validées), liste des packages du fichier ouvert (ligne,
      options, retrait, une étape d'annulation par opération) ; lecture seule : recherche et liste.
      Dans les logs, une erreur « File `xyz.sty' not found » (ou `.cls`) affiche les noms proches
(`GET /texlive/suggestions`, mémorisés pour la session) et, pour un éditeur, un bouton qui
ouvre le fichier du log (sinon le document principal) et corrige le nom dans le
`\usepackage`/`\documentclass` de cette ligne (`planRenamePackage`, `lib/package-tools.ts`).
    - **Autocomplétion** (`use-project-index.ts`) : `ProjectIndex` de `@kaxolax/editor` alimenté
      par des lecteurs Yjs sans présence de tous les `.tex`/`.sty`/`.cls`/`.bib` du projet (200 au
      plus, `.bib` d'abord ; ouverts et fermés au fil de l'arborescence, renommages suivis) et par
      le document ouvert (pause de 250 ms) ; chemins de toute l'arborescence. Après
      `\usepackage{`, les noms de tout TeX Live sont demandés à l'API pendant la frappe
      (`editor/package-name-completion.ts`, réponses mémorisées par préfixe).
    - **Correcteur** : worker `src/workers/spellcheck.worker.ts` créé à la première activation
      (Hunspell WebAssembly), dictionnaires `fr`/`en` servis par l'application
      (`app/dictionaries/[file]`, route statique générée au build depuis `dictionary-fr` et
      `dictionary-en`, aucun CDN) et téléchargés à la première vérification de la langue ; langue
      du projet (paramètres → Projet, propriétaire et éditeurs) ; clic droit ou F7 (Remplacer →
      Corriger l'orthographe) sur un mot souligné : suggestions, ajout au dictionnaire personnel.
    - **Compteur de mots** (Fichier → Compteur de mots, ou « Mots » dans la barre d'état) :
      `POST /projects/:id/word-count` (texcount dans le sandbox) après envoi des dernières
      frappes ; document principal ou fichier ouvert ; total, texte, titres, légendes, formules,
      détail par section ; chargement, erreurs traduites, Recompter.
    - **Barre d'état** sous l'éditeur : ligne et colonne, mode Vim/Emacs, langue du correcteur,
      compteur de mots, paramètres.
  - PDF (pdf.js) : pastille de statut (Recompiler, Ctrl+Entrée) et son menu (auto-compilation,
    compilateur, brouillon, arrêt à la première erreur, arrêt, vider le cache, logs), zoom
    (page, largeur, 50 à 400 %), téléchargement, menu ⋯ (zip des sources, fichiers de sortie,
    nouvel onglet, impression), tiroir des logs (erreurs cliquables, log brut), barre flottante (annuler,
    pages, « Aller au PDF » par SyncTeX) ; un double-clic dans le PDF place le curseur sur la
    ligne source. Le PDF de la dernière compilation s'affiche dès l'ouverture du projet.
    Compilation asynchrone (API en `COMPILE_BACKEND=cloudflare`) : machine d'état sans React
    `lib/compile-controller.ts` (testée), enveloppée par `workspace/use-compile.ts`. Le mode est
    reconnu à la réponse : résultat direct (`gateway`), ou 202 `{ buildId, status }` dont l'état
    avance par les événements `compile.updated` du document meta (ceux d'un autre `buildId` sont
    ignorés ; jamais de retour en arrière, `lib/builds.ts`), avec un sondage de repli de
    `GET …/builds/:buildId` (3 s, puis 5 s et 10 s ; arrêt sur état final, abandon après
    15 min). La pastille affiche « Préparation du compilateur… » (réveil du conteneur),
    « En attente… » (file) ou « Compilation… » ; le résultat (PDF, logs, erreurs, SyncTeX,
    limite du plan) s'affiche comme en mode synchrone, et un résultat retiré de l'événement
    (`resultOmitted`) est relu par l'API. Double clic : en mode synchrone, la dernière demande
    remplace la précédente ; en asynchrone (ou tant que le mode est inconnu), une seule relance
    est mise en attente jusqu'à la fin de la compilation suivie, de même après un 409
    `E_COMPILE_IN_PROGRESS`. Arrêter annule cette relance et termine l'état local dès que l'API
    confirme. Une compilation déjà en cours à l'ouverture (autre onglet, autre membre,
    auto-compilation) est suivie dès son premier événement. Pour qui peut modifier le projet,
    l'éditeur appelle `compiler/warm` sans attendre sa réponse, à l'ouverture seulement, au plus
    une fois par projet toutes les 10 min (`WarmSchedule`), et plus du tout si l'API répond
    `unsupported`.
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
    (activer, désactiver, copier, régénérer avec confirmation). `E_PLAN_LIMIT` : `PlanLimitNotice`
    dans la modale (limite et lien `upgradeUrl` vers les tarifs), l'erreur marquée
    (`markPlanLimitHandled`) pour que la boîte des limites globale ne s'ouvre pas aussi. Autres rôles : vue limitée (membres
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
  soleil/lune du pied de sidebar, et paramètres), `layout` (tailles des colonnes, repli),
  `toolsVisible`, `autoCompile`, `compile` (brouillon, arrêt à la première erreur), `openTabs`
  (onglets par projet), `recentSymbols` (sélecteur de symboles), `editor` (paramètres de
  l'éditeur) et `spellcheckDictionary` (dictionnaire personnel).
- **Paramètres** (`components/preferences/settings-*.tsx`, chargés à la première ouverture) :
  depuis le pied de sidebar (roue dentée), le menu du compte (`UserButton`), la barre d'état ou
  Fichier → Paramètres de l'éditeur. Onglets Éditeur (thème clair/sombre, coloration, police
  prédéfinie ou saisie, taille, hauteur de ligne, raccourcis par défaut/Vim/Emacs, retour à la
  ligne, aperçu), Correcteur (activation, dictionnaire personnel : ajout, retrait) et Projet
  (langue du correcteur, page projet). Enregistrés dans les préférences (tous les appareils) et
  appliqués à chaud par `reconfigureEditor` : seuls les réglages modifiés sont reconfigurés
  (`settingsChange`), le document, l'historique et l'état Vim sont gardés. Le thème
  est recopié dans le cookie `kaxolax-theme` (rendu serveur de `data-theme`, sans flash) et dans
  localStorage (`ThemeScript`).

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
