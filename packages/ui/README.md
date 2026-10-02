# @kaxolax/ui

Composants d'interface partagés (shadcn/ui sur Radix via `radix-ui`, `cva`, `cn`) et jetons de design de Kaxolax. Compilé avec `tsc` vers `dist/` : `pnpm --filter @kaxolax/ui build` avant de lancer une application.

## Installation dans une application Next.js

```css
/* src/app/globals.css */
@import 'tailwindcss';
@import '@kaxolax/ui/tokens.css';
/* Chemin relatif vers packages/ui/src : Tailwind y lit les classes des composants. */
@source '../../../../packages/ui/src';
```

```tsx
// src/app/layout.tsx (composant serveur)
import { ThemeScript, TooltipProvider } from '@kaxolax/ui'

;<html lang="fr" suppressHydrationWarning>
  <head>
    <ThemeScript />
  </head>
  <body>
    <TooltipProvider>{children}</TooltipProvider>
  </body>
</html>
```

`tokens.css` est servi tel quel (pas de build). Il déclare les variables, le bloc `@theme inline` de Tailwind 4 et la variante `dark:`.

## Thèmes

- Clair sur `:root`, sombre sous `[data-theme='dark']` ou `.dark`. Le thème par défaut est **sombre** (concept : sidebar et éditeur sombres).
- `[data-theme='light']` ou `.light` sur un sous-arbre le remet en clair (colonne PDF, aperçus). La variante `dark:` ne s'y applique pas.
- `ThemeScript` (ou `themeScript()` pour un `<script>` maison) pose `data-theme` sur `<html>` avant le premier rendu : préférence rendue par le serveur dans `data-theme-preference`, sinon `localStorage['kaxolax:theme']`, sinon sombre. `applyThemePreference('light' | 'dark' | 'system')` l'applique ensuite depuis les paramètres ; `subscribeSystemTheme` suit le système pour `system`.

## Jetons

Toutes les couleurs sont en oklch. Chaque variable `--x` a son utilitaire Tailwind (`bg-x`, `text-x`, `border-x`…).

| Groupe              | Variables                                                                                                                                                                                                                                                                                                                                  | Usage                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base shadcn         | `background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive` (et leurs `-foreground`), `border`, `input`, `ring`                                                                                                                                                                                | Composants génériques. `primary` = vert de marque `oklch(0.42 0.12 160)` en clair, éclairci en sombre.                                                                                             |
| États               | `success`, `warning` (+ `-foreground`)                                                                                                                                                                                                                                                                                                     | Pastille « Compiled ✓ », avertissements.                                                                                                                                                           |
| Tools               | `tools`, `tools-foreground`                                                                                                                                                                                                                                                                                                                | Accent bleu du bouton Tools (`Button variant="accent"`).                                                                                                                                           |
| Sidebar             | `sidebar`, `sidebar-foreground`, `sidebar-muted-foreground`, `sidebar-primary(-foreground)`, `sidebar-accent(-foreground)`, `sidebar-border`, `sidebar-ring`                                                                                                                                                                               | Colonne de gauche.                                                                                                                                                                                 |
| Éditeur             | `editor`, `editor-foreground`, `editor-gutter(-foreground)`, `editor-gutter-active-foreground`, `editor-active-line(-border)`, `editor-selection`, `editor-cursor`, `editor-match`, `editor-border`, `editor-tabbar`, `editor-tab-foreground`, `editor-tab-active(-foreground, -border)`, `editor-toolbar(-foreground)`, `editor-syntax-*` | CodeMirror, barre d'onglets, barre Tools. Les `editor-syntax-*` (keyword, tag, atom, number, comment, string, bracket, variable, invalid) colorent le LaTeX.                                       |
| PDF                 | `pdf`, `pdf-foreground`, `pdf-muted-foreground`, `pdf-toolbar(-foreground)`, `pdf-accent`, `pdf-border`, `pdf-page`, `pdf-floating(-foreground)`, `pdf-highlight`                                                                                                                                                                          | Colonne PDF, **claire dans les deux thèmes**.                                                                                                                                                      |
| Présence            | `presence-1` à `presence-8`, `presence-foreground`                                                                                                                                                                                                                                                                                         | Curseurs et avatars des collaborateurs ; même teinte dans les deux thèmes, luminosité adaptée. `presenceColorIndex(userId)` donne un index stable, `presenceColor(index, opacity?)` la valeur CSS. |
| Rayons              | `--radius` → `rounded-sm/md/lg/xl`                                                                                                                                                                                                                                                                                                         |                                                                                                                                                                                                    |
| Tailles             | `--bar-height` (`h-bar`), `--toolbar-height` (`h-toolbar`), `--tab-height` (`h-tab`), `--sidebar-footer-height` (`h-sidebar-footer`), `--ask-height` (`h-ask`), `--rail-width` (`w-rail`), `--gutter` (`px-gutter`)                                                                                                                        | Barres de l'interface ; connues de `cn` (tailwind-merge).                                                                                                                                          |
| Police de l'éditeur | `--editor-font-family` (`font-editor`), `--editor-font-size`, `--editor-line-height`                                                                                                                                                                                                                                                       | Surchargées sur `<html>` par les préférences.                                                                                                                                                      |
| Ombre               | `shadow-floating`                                                                                                                                                                                                                                                                                                                          | Barre flottante du PDF.                                                                                                                                                                            |

## Composants

Alert, Avatar (+ `PresenceAvatar`), AvatarStack (pile avec pastille « +N » et liste des autres personnes), Badge, Button (variantes `default`, `destructive`, `outline`, `secondary`, `ghost`, `link`, `accent` ; tailles `xs`, `sm`, `default`, `lg`, `icon`, `icon-sm`, `icon-xs`), Card, Checkbox, Collapsible, Command (palette sans dépendance externe : filtre sans casse ni accents, ↑ ↓ Entrée, `CommandDialog`), Dialog, DropdownMenu (sous-menus, éléments cochables et radio, libellés, séparateurs, raccourcis), Input, NativeSelect, Kbd (`KbdShortcut` pour un raccourci CodeMirror `Mod-Enter`), Label, Logo, Menubar (barre Tools), Popover, Resizable* (types `ResizableGroupHandle`, `ResizablePanelHandle` pour `groupRef` et `panelRef`), ScrollArea, Separator, Sheet (tiroir, éventuellement dans un conteneur : `container`), Skeleton, Spinner, Switch, Tabs (variantes `default` et `line`), ThemeScript, Toggle, ToggleGroup, Tooltip (+ `TooltipProvider`, `SimpleTooltip` avec raccourci).

Utilitaires : `cn`, `formatShortcut(Text)`, `matchesSearch`, `initialsOf`, `splitAvatarStack`, helpers de thème.

## Vérifications

`pnpm --filter @kaxolax/ui build lint typecheck test`.
