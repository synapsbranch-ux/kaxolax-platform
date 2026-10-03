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
  paiement dans l'onglet Billing de `/account` (`/account/billing`). Menu du compte : « Plan … et
  usage » (`/account/plan`), « Facturation » (`/account/billing`) et « Tarifs » (`/pricing`).
  **Plan et usage** (`components/billing/plan-usage.tsx`, `lib/plan-usage.ts`) : plan, stockage
  utilisé (jauge), durée de compilation, collaborateurs, historique, features et état de
  l'abonnement, lus dans `GET /api/v1/me/plan`, sur la page « Plan et usage » ajoutée à
  `<UserProfile />` (`components/billing/account-profile.tsx`) et dans l'onglet Plan des
  paramètres. `has({ plan })` et `has({ feature })` de Clerk ne servent qu'à l'affichage (libellé
  du menu, badge et features avant la réponse de l'API) : chaque limite est appliquée par l'API. Les
  refus 403 `E_PLAN_LIMIT` de l'API s'expliquent dans `PlanLimitNotice`
  (`components/billing/plan-limit-notice.tsx`, message, limite, bouton vers les tarifs) : en
  ligne dans le résultat d'une compilation en délai dépassé, sinon dans une boîte de dialogue
  commune (`PlanLimitDialog`, layout `(app)`) pour tout appel de l'API ; un écran qui affiche le
  refus lui-même (modale de partage) appelle `markPlanLimitHandled(error)` dans son `catch` et
  passe `error.planLimit` au composant.
- **Équipes (Organisations Clerk)** (`components/teams/`, `lib/teams.ts`) : sélecteur de
  workspace maison (pied de sidebar, barre du tableau de bord sur écran étroit ;
  `components/workspace/sidebar/sidebar-footer.tsx`) branché sur `GET /api/v1/workspaces` :
  « Personnel » puis les équipes, tableau de bord filtré (`?workspace=`) et organisation active de
  Clerk alignée (`setActive`, aucune pour le personnel) pour que le jeton porte le plan de
  l'équipe ; « Créer une équipe » (`/team/new`, `<CreateOrganization />`) et « Gérer l'équipe ».
  Page de l'équipe `/team/<org_…>` : nom, rôle, sièges, badge du plan, plan et usage mutualisés
  (`GET /workspaces/:id/plan` : stockage, compilation, invités, historique, crédits par siège),
  lien vers ses projets et `<OrganizationProfile />` (membres, invitations, rôles, facturation
  de l'organisation quand Billing est activé pour les organisations). L'organisation y devient
  active ; tant que son workspace n'existe pas (webhook en route, ou absent en local sans tunnel),
  la page appelle `POST /workspaces/sync` et relit toutes les 2 s (une minute au plus). Tableau de
  bord : invitations d'équipe en attente (« Rejoindre », `useOrganizationList`), bandeau de
  l'équipe affichée (sièges, rôle, plan, jauge du stockage mutualisé), badge d'équipe des projets,
  « Déplacer vers une équipe… » (projet personnel possédé, `POST /projects/:id/move`). Modale de
  partage d'un projet d'équipe : accès de l'équipe et rôle de ses membres
  (`PUT /projects/:id/team-access`). `/pricing#team` : plan Team et `<PricingTable
for="organization" />` pour l'organisation active. Les `has()` du plan personnel sont de portée
  utilisateur (`u:pro`, `u:<feature>`) : sans préfixe, Clerk accepterait aussi ceux de
  l'organisation active.
- **Intégrations** (`/account/integrations`, page ajoutée à `<UserProfile />`) : connecter
  Zotero (OAuth sur zotero.org, accès en lecture seule) ou le déconnecter
  (`components/integrations/zotero-connection.tsx`). zotero.org renvoie sur
  `/integrations/zotero/callback`, qui termine la connexion auprès de l'API avec la même session
  puis revient aux intégrations.
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
  reçues en direct sur toutes les pages connectées par le canal temps réel du compte
  (`components/use-user-channel.ts` : document `user:{id}` sur un WebSocket dédié, jeton de
  `POST /api/v1/me/realtime-token`, événement `banner.changed` lu par `parseBroadcastMessage`),
  et aussi sur la page projet par le document meta (`bannerFeed` de `lib/project-events.ts`).
  `GET /api/v1/banners/active` est relu à chaque (re)connexion du canal, toutes les 60 s et au
  retour sur l'onglet, en filet (connexion temps réel coupée). Canal refusé ou fermé par le
  serveur : réouvert après 5 s, délai doublé à chaque échec (1 min au plus, `lib/user-channel.ts`).
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
    - **Zotero** (étape 3, `lib/zotero.ts`) : panneau Fichier → « Zotero : bibliothèque liée »
      (`tools/zotero-dialog.tsx` : bibliothèque, collection, `.bib` cible, format, état et date
      de la dernière synchro, erreurs, Synchroniser, Modifier, Retirer le lien ; lecture pour
      tous, actions pour les éditeurs) ; Structures → « Insérer une citation Zotero »
      (`tools/zotero-citation-dialog.tsx` : recherche, `\cite{clé}` au curseur ou ajouté à la
      citation sous le curseur, entrée ajoutée au `.bib`) ; autocomplétion de `\cite{` complétée
      par la bibliothèque liée (`useProjectZotero`, source `externalCitationSource` de
      `@kaxolax/editor`) ; synchro `open` à l'ouverture du projet (éditeurs, limitée par l'API) ;
      événement `zotero.updated` pour les panneaux ouverts.
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
    auto-compilation) est suivie dès son premier événement. Pour tout rôle qui peut compiler
    (permission `compile` de la matrice, lecteur et relecteur compris : `warmsCompiler`),
    l'éditeur appelle `compiler/warm` sans attendre sa réponse, à l'ouverture seulement, au plus
    une fois par projet toutes les 10 min (`WarmSchedule`), et plus du tout si l'API répond
    `unsupported` (l'API plafonne les réveils par utilisateur sans jamais refuser).
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
  - Suivi des modifications (`workspace/use-edit-mode.ts`, `workspace/use-project-suggestions.ts`,
    `panels/suggestions-section.tsx`, logique dans `lib/suggestions.ts` et
    `lib/suggestion-recorder.ts`, extension `suggestionTracking` de `@kaxolax/editor`) : bascule
    « Modifier / Suggérer » dans la barre des onglets (Ctrl+Alt+R), mémorisée par utilisateur et
    par projet dans le stockage local (`kaxolax:edit-mode:<user>:<projet>`) ; Suggérer imposé au
    relecteur (pastille « Suggestion »), rien pour le lecteur. En mode Suggérer, l'éditeur reste
    modifiable mais intercepte chaque modification locale (frappe, collage, autocomplétion, outil)
    avant le texte Yjs : seules les mises à jour reçues (`ySyncAnnotation`) passent. Les outils de
    la barre Tools qui modifient le texte restent donc disponibles en Suggérer, même pour un
    relecteur (`actionsReadOnly`) ; fichiers et dossiers restent réservés aux éditeurs. Les frappes
    sont fusionnées en une suggestion (`recordSuggestionEdit` de `@kaxolax/collab`, coordonnées
    converties par `suggestionViewEdit`, suggestion élargie quand la frappe suit le curseur),
    envoyées après 400 ms (`POST`, puis `PATCH`, `DELETE` si elles s'annulent) par une file
    ordonnée ; Ctrl+Z retire la suggestion en cours, Rétablir (Ctrl+Y, Ctrl+Maj+Z) ne fait rien.
    Une suggestion décidée ou retirée ailleurs (événement, panneau Review) fait oublier son
    brouillon à l'éditeur (`suggestionsGone`, `SuggestionRecorder.discard`). Affichage en ligne : texte d'origine barré,
    texte proposé en widget, à la couleur de présence de l'auteur (tirets pour un brouillon pas
    encore enregistré), info-bulle (auteur, date, Accepter / Refuser pour l'éditeur et le
    propriétaire, Retirer pour l'auteur), Ctrl+Alt+Entrée accepte et Ctrl+Alt+Maj+Entrée refuse
    la suggestion sous le curseur. Suggestions ouvertes et obsolètes chargées à l'ouverture
    (seule la dernière relecture compte ; une suggestion changée pendant la lecture garde son
    état courant, `mergeReloaded`),
    tenues à jour par `suggestion.created`, `suggestion.updated` et `suggestion.decided`
    (relayés par `suggestionFeed`). Panneau Review, section Suggestions : filtres par auteur et
    par document, ordre du texte du document actif, précédent / suivant, clic → saut à la
    suggestion (document ouvert au besoin), accepter / refuser une suggestion, écarter (éditeur,
    propriétaire) ou retirer (auteur) une suggestion obsolète, « Tout accepter » et « Tout
    refuser » (obsolètes comprises ; filtres appliqués : un auteur, un document, après confirmation ;
    relancés tant que l'API en signale d'autres), bilan (acceptées, refusées, obsolètes) ;
    obsolète : badge et explication, aussi détectée dans le texte courant avant la décision.
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
  ligne, aperçu), Correcteur (activation, dictionnaire personnel : ajout, retrait), Projet
  (langue du correcteur, page projet) et Plan (plan et usage, en lecture). Enregistrés dans les préférences (tous les appareils) et
  appliqués à chaud par `reconfigureEditor` : seuls les réglages modifiés sont reconfigurés
  (`settingsChange`), le document, l'historique et l'état Vim sont gardés. Le thème
  est recopié dans le cookie `kaxolax-theme` (rendu serveur de `data-theme`, sans flash) et dans
  localStorage (`ThemeScript`).

## En-têtes de sécurité et CSP

`src/lib/security-headers.ts` (testé dans `security-headers.test.ts`) :

- **CSP stricte sur chaque page**, posée par le proxy (`src/proxy.ts`) avec l'option
  `contentSecurityPolicy` de `clerkMiddleware` : nonce par requête (en-têtes `x-nonce` et
  `Content-Security-Policy` de la requête : Next.js l'applique à ses scripts, le layout racine le
  passe à `ClerkProvider` et à `ThemeScript`) et `'strict-dynamic'` (scripts chargés par ceux-ci :
  Clerk UI, Turnstile, Stripe). Clerk ajoute ses origines (Frontend API de l'instance tirée de
  `CLERK_PUBLISHABLE_KEY`, `img.clerk.com`, `challenges.cloudflare.com`, Stripe pour Billing,
  télémétrie, workers `blob:`; les composants d'Organisations n'en demandent pas d'autre : logos
  sur `img.clerk.com`, appels à la Frontend API), et `'unsafe-eval'` en développement seulement (rechargement à
  chaud). L'application ajoute : `connect-src` temps réel, stockage et templates ; `img-src`
  `data:`, `blob:`, stockage et templates ; `font-src 'self' data:` (polices locales, MathLive,
  pdf.js) ; `worker-src 'self' blob:` (correcteur, pdf.js) ; `frame-src blob:` (impression du
  PDF) ; `'wasm-unsafe-eval'` (WebAssembly seulement : Hunspell et décodeurs pdf.js, dans des
  workers que certains navigateurs soumettent à la politique de la page) ; `object-src 'none'`,
  `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`. Styles : `'unsafe-inline'`
  (Clerk, CodeMirror, MathLive et les attributs `style` de React l'exigent ; un nonce de style
  bloquerait les attributs). Jamais d'`'unsafe-eval'` en production : zod est réglé sans
  compilation de ses validateurs dans le navigateur (`src/instrumentation-client.ts`).
- **Origines de la CSP** (lues à l'exécution, mêmes valeurs que dans apps/api) :
  `REALTIME_PUBLIC_URL` (`wss://…`), `S3_PUBLIC_ENDPOINT` (origine des URL présignées de l'API ;
  à défaut `S3_ENDPOINT`, comme l'API ; en https, ses sous-domaines aussi), `TEMPLATES_PUBLIC_URL`
  et `TEMPLATES_CATALOG_URL` (fichiers publics des templates). Hors production, défauts de la
  pile locale (`ws://localhost:1234`, `http://localhost:8333`). En production, aucun défaut
  local : celles qui manquent sur le service web sont lues sur l'API (`GET /api/v1/client-config`
  par `API_INTERNAL_URL`, `src/lib/csp-sources.ts`), gardées 5 min puis relues en arrière-plan ;
  API injoignable : la page est servie avec la dernière réponse (ou les seules variables) et un
  nouvel essai a lieu 30 s plus tard. Le démarrage le signale par un avertissement
  (`src/instrumentation.ts`, `missingCspOrigins` de `src/env.ts`) et ne s'arrête que sur une
  valeur invalide. Les donner aussi au service web évite cette lecture.
- **En-têtes fixes de toutes les réponses** (`next.config.ts`) : `X-Content-Type-Options:
nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`,
  `Permissions-Policy` (caméra, micro, géolocalisation, USB, série, HID refusés ; paiement
  réservé à Stripe). HSTS est posé par Cloudflare.

## Développement

```bash
pnpm --filter @kaxolax/web dev        # http://localhost:3000 (l'API doit tourner sur :3333 ; clés Clerk dans .env)
pnpm --filter @kaxolax/web test       # Vitest (utilitaires)
```

## Parcours e2e et captures d'écran (Playwright)

Ils supposent toute la pile lancée : `docker compose up -d` (PostgreSQL, Redis, S3, Mailpit),
l'image TeX Live, puis `pnpm dev` à la racine (API, temps réel, gateway, agent, web sur :3000,
admin sur :3001) ; ils ne lancent rien eux-mêmes. `e2e` se limite à la « Définition de terminé »
et à la MFA (`dod.spec.ts`, `auth.spec.ts`, quelques minutes) : c'est ce que lance le job
`integration` de la CI, déjà chargé (agent de compilation sous runc puis gVisor, délai de
45 min, admin non démarré). `e2e:all` lance tous les parcours (une à deux heures, admin et
Mailpit compris) : à lancer à la main sur la pile locale ou une instance déployée.

```bash
pnpm --filter @kaxolax/web exec playwright install chromium   # une fois
pnpm --filter @kaxolax/web e2e                                # DoD et MFA (comme la CI)
pnpm --filter @kaxolax/web e2e:all                            # tous les parcours (projet chromium)
pnpm --filter @kaxolax/web screenshots                        # captures (projet screenshots)
pnpm --filter @kaxolax/web exec playwright test --list        # liste, sans rien lancer
pnpm --filter @kaxolax/web exec playwright test e2e/chat.spec.ts   # un seul domaine
```

Variables (environnement du shell, pas de `.env` lu) :

| Variable                                     | Rôle                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`  | instance Clerk **de développement** (obligatoires, `global-setup.ts`) |
| `E2E_BASE_URL`                               | application (défaut `http://localhost:3000`)                          |
| `E2E_ADMIN_URL`                              | admin (défaut `http://localhost:3001`)                                |
| `E2E_MAILPIT_URL`                            | API de Mailpit (défaut `http://localhost:8025`)                       |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE`             | Chromium déjà installé, à la place de celui de Playwright             |
| `E2E_ZOTERO_USERNAME`, `E2E_ZOTERO_PASSWORD` | compte zotero.org de test (`zotero.spec.ts`, sauté sans elles)        |
| `E2E_ZOTERO_QUERY`                           | texte d'une référence de ce compte (défaut `the`)                     |

Parcours (un fichier par domaine, `e2e/*.spec.ts`), chacun indépendant : il crée ses comptes et
ses projets, et les supprime à la fin (projets possédés par l'API, comptes par l'API Backend de
Clerk) :

- `dod.spec.ts` (étape 1, compte créé par l'inscription Clerk) et `auth.spec.ts` (MFA) ;
- `sharing.spec.ts` : invitation par email avec rôle et acceptation, invitée sans compte qui
  s'inscrit et rejoint le projet automatiquement, relance et annulation d'une invitation, liens
  lecture et édition, régénération, changement de rôle en direct, retrait (déconnexion en moins
  de 2 s), départ d'un membre, transfert ;
- `presence.spec.ts` : curseur et nom, pastille de l'arborescence, pile d'avatars, suivi ;
- `chat.spec.ts` : message reçu en moins d'une seconde, non-lus après rechargement, mention,
  lien `main.tex:42`, historique paginé (« Messages précédents ») ;
- `comments.spec.ts` : commentaire d'une sélection, ancrage après des modifications autour,
  réponse, résolution, relecteur qui commente, lecteur qui ne peut pas ; modifier et supprimer
  son message, rouvrir un fil, commentaire précédent et suivant, texte ancré supprimé (citation
  barrée) ; email d'une @mention en commentaire (lien qui ouvre le fil) et dans le chat ;
- `suggestions.spec.ts` : un relecteur suggère (mode Suggérer imposé, texte inchangé, ajout et
  remplacement affichés en ligne chez tous), la propriétaire accepte depuis le panneau Review et
  refuse depuis l'info-bulle, le texte accepté est attribué au relecteur dans l'historique ;
  bascule mémorisée après rechargement, lecteur sans bascule, Ctrl+Z en mode Suggérer,
  suggestion obsolète, « Tout accepter » d'un auteur ;
- `history.spec.ts` : version d'une compilation, diff par auteur, label, restauration exacte du
  texte et d'une image, restauration d'un seul fichier, zip d'une version ;
- `writing-tools.spec.ts` : formules (MathLive) insérées, remplacées et compilées, symboles,
  package et symboles récents, tableaux (aller-retour : rouvert, modifié, réinséré ; collage
  depuis un tableur, fichier CSV, `\multicolumn` et `\multirow`), gestionnaire de packages, nom
  de package corrigé depuis les logs, compteur de mots (total, titres, légendes, détail par
  section), paramètres (thème clair, coloration, police, taille, hauteur de ligne, raccourcis Vim
  et Emacs, retour à la ligne, correcteur désactivé) appliqués à chaud, gardés après rechargement
  et sur un autre appareil, autocomplétion (`\cite{` mesurée, `\ref`, `\eqref`, commandes des
  packages chargés, chemins de `\input` et `\includegraphics`) ;
- `zotero.spec.ts` (étape 3, sauté sans compte Zotero de test ni application OAuth sur l'API) :
  connexion OAuth sur zotero.org, lien de la bibliothèque, synchro vers `references.bib`,
  synchro idempotente, citation insérée par le sélecteur ; captures `zotero-panel.png` et
  `zotero-citation-picker.png` dans `e2e/screenshots/` ;
- `spellcheck.spec.ts` : correcteur (langue du projet changée depuis la barre d'état, commandes
  LaTeX et maths ignorées, correction proposée au clic droit, dictionnaire personnel gardé après
  rechargement) ;
- `interface.spec.ts` : menu de la pastille (auto-compilation, compilateur, brouillon, arrêt à la
  première erreur, vider le cache, voir les logs), états du PDF (jamais compilé, échec sans PDF
  et lien vers les logs), arborescence (dossier et fichier créés, fichier renommé, déplacé et
  supprimé) diffusée en direct à un autre membre connecté, plan du document (section courante, saut), recherche dans le projet,
  colonnes, sidebar et barre Tools mémorisées par utilisateur (autre appareil, autre membre),
  onglets Éditeur et PDF sous 1024 px, onglets ouverts propres à chaque utilisateur, sélecteur de
  projet, zoom, téléchargements et fichiers de sortie du PDF, barre flottante (pages, « Aller au
  PDF », annuler et rétablir), filtre par workspace ;
- `templates.spec.ts` : galerie publique, recherche, filtre par catégorie, fiche, « Utiliser ce
  template » depuis la fiche et depuis le tableau de bord (« Depuis un template ») ;
- `plan-limits.spec.ts` : limites du plan Free appliquées par l'API (`E_PLAN_LIMIT`) avec le lien
  vers `/pricing` : collaborateurs (modale de partage), durée de compilation (PDF), stockage
  (upload refusé) ; onglet Billing de `/account` ;
- `teams.spec.ts` : création d'une équipe (`<CreateOrganization />` depuis le sélecteur de
  workspace), invitation d'un second compte depuis la page de l'équipe et acceptation dans son
  tableau de bord, projet personnel déplacé vers l'équipe, accès du membre (éditeur, puis
  lecteur en direct par le réglage d'équipe du partage), retrait du membre dans
  `<OrganizationProfile />` : déconnexion du projet et 404. Organizations doit être activé sur
  l'instance ; sans tunnel, le parcours constate le retrait par `POST /workspaces/sync`
  (`e2e/teams.ts`), et supprime l'organisation à la fin ;
- `admin.spec.ts` : accès refusé sans rôle ou sans MFA, ouvert avec les deux, recherche d'un
  utilisateur, bannière reçue en direct par l'application, journal ; bannir (déconnexion
  immédiate, temps réel compris, reconnexion refusée), débannir, révoquer les sessions,
  supprimer un compte ; projets (recherche par nom, propriétaire ou id, sans accès au contenu,
  transfert, archivage, corbeille, restauration, suppression définitive) ; statistiques.

Outils communs : `accounts.ts` (fixture `accounts` : comptes créés par l'API Backend de Clerk,
chacun dans son propre contexte de navigateur, connectés par un jeton de connexion de
`@clerk/testing`, ou par mot de passe et TOTP pour un compte avec MFA), `project.ts` (import d'un
projet en zip depuis le tableau de bord, éditeur, compilation, outils, partage, chat,
commentaires, suggestions), `api.ts` (appels de l'API avec le jeton de la page, pour préparer et nettoyer),
`clerk.ts`, `admin.ts`, `mailpit.ts`, `demo.ts` (projet de démonstration), `files.ts` (zip et PNG
sans dépendance, testés par Vitest). `compile()` suit les deux modes de l'API : réponse
synchrone (`gateway`), ou 202 `{ buildId, status }` suivi par la pastille de compilation jusqu'à
un état final, puis résultat relu par `GET /projects/:id/builds/:buildId` (`cloudflare`).

**Compte admin** : `admin.spec.ts` et les captures créent un compte avec un secret TOTP
(`createUser({ totpSecret })`) et le rôle `publicMetadata.role = "admin"` par l'API Backend ; la
connexion à l'admin saisit le mot de passe puis un code TOTP. Rien à préparer à la main, mais
l'instance doit avoir la MFA par application d'authentification activée et le jeton de session
personnalisé du README racine (claims `name`, `email`, `metadata`).

**Ce qui ne marche que contre l'instance Clerk de développement** : adresses `+clerk_test`
(code `424242`), jeton de test (`clerkSetup`) et jetons de connexion : tous les parcours. Une
instance de production refuse ces raccourcis. Contre un environnement déployé
(`E2E_BASE_URL=https://… E2E_ADMIN_URL=https://…`), il faut donc des clés de développement sur
cet environnement. Sans Mailpit (fournisseur SMTP réel), l'invitation par email est sautée
avec la raison ; avec le catalogue de démonstration local (sans fichiers), la création depuis un
template l'est aussi (définir `TEMPLATES_CATALOG_URL` côté API) ; les emails de mention
aussi ; chaque limite du plan est sautée si le plan du compte de test ne l'a pas (ou l'a trop
haute pour un parcours), et l'onglet Billing si Clerk Billing n'est pas activé. Les miroirs locaux des comptes supprimés restent
dans la base de développement quand le webhook Clerk n'atteint pas l'API (pas de tunnel).

**Captures d'écran** (`e2e/screenshots.spec.ts`, projet `screenshots`) : un projet de
démonstration est semé (fichiers, image, bibliographie, deux collaboratrices, commentaires,
suggestions, messages, versions, lien de partage, invitation, correcteur en français), puis chaque écran
(`SCREENS` de `e2e/screens.ts` : connexion et inscription, pages, nouveau projet depuis un
template, bannière système active (créée puis supprimée par l'admin), menus de la pastille et
du PDF, limite de collaborateurs atteinte, correcteur, pages pour rejoindre un projet, historique, compte et facturation, équipes (sélecteur, projets et plan de l'équipe, page de l'équipe, création), fiches et organisations de l'admin…) est capturé en
pleine page, en thème sombre et clair, en 1440×900 et 390×844 (l'admin n'a que le thème
sombre) : `e2e/screenshots/<écran>--<thème>--<taille>.png`, noms stables, dossier ignoré par
git, vidé au début de chaque passage (aucune image périmée), et `e2e/screenshots/index.md`
régénéré à la fin. Toutes les variantes sont les étapes d'un seul test (projet semé une fois) :
un écran ou une variante qui échoue n'empêche pas les suivants ; le parcours échoue ensuite en
listant les écrans manquants. Un écran sans objet (Billing désactivé, pas de Mailpit, plan sans
limite de collaborateurs) est sauté,
avec la raison dans les annotations du rapport.
