# Direction UI : un outil de travail en grille

> Spécification à implémenter **telle quelle** par le développeur front. Elle remplace les choix
> visuels actuels (panneau sombre à halos, cartes arrondies, pastilles, accent indigo) par une
> interface de bureau sobre et dense, construite autour d'une **grille de données** dont les
> conventions sont celles des tableurs que l'évaluateur utilise tous les jours.
>
> Contraintes : aucune dépendance ajoutée. Tout se fait avec React 19, Tailwind v4,
> `@radix-ui/react-select`, `@radix-ui/react-slot`, `@radix-ui/react-label`, `lucide-react`
> et `react-dom` (`createPortal`). Aucune référence de marque dans l'interface : on reprend des
> **conventions d'usage** (quadrillage, en-têtes triables, filtre par colonne, barre d'état),
> jamais un logo, un ruban, une couleur de marque ni le nom d'un logiciel.

---

## 1. Principes

1. **La donnée d'abord.** Chaque écran de données est une grille pleine largeur et pleine
   hauteur ; le reste (titres, outils) tient en deux lignes au-dessus.
2. **Des repères familiers.** Quadrillage, ligne d'en-tête figée, numéros de ligne, tri par clic
   sur l'en-tête, filtre par colonne avec cases à cocher, barre d'état. L'évaluateur ne doit rien
   apprendre.
3. **Hiérarchie par la typographie et l'alignement**, pas par la décoration : graisse, taille,
   colonne, filet. Pas de boîte pour attirer l'œil.
4. **Une seule couleur d'accent** (bleu de bureau), réservée à l'action principale, à la
   sélection, au focus et aux liens. Les couleurs d'état (erreur, avertissement, succès) ne
   servent qu'à porter un état, toujours doublées d'un texte ou d'une icône.
5. **Dense mais lisible** : lignes de 28 px, texte 13 px dans la grille, contrastes AA partout.
6. **Immédiat** : pas d'animation ni de transition (hors indicateur de chargement).
7. **Commandes à gauche, informations à droite** : dans chaque barre d'outils, l'action de la
   page vient en premier, puis les outils de vue (recherche, filtres).

### À bannir (aucune occurrence tolérée dans `src/`)

| Catégorie | Interdit |
|---|---|
| Effets | `bg-gradient-*`, `from-*`/`via-*`/`to-*`, `blur-*`, `backdrop-blur*`, fonds translucides (`bg-background/85`, `bg-white/10`…), halos/blobs décoratifs (`absolute … rounded-full … blur-3xl`) |
| Ombres | `shadow-xs`, `shadow-sm`, `shadow`, `shadow-lg`, `shadow-xl` ; seule exception : `shadow-md` sur les menus flottants (remappée sur une ombre courte, cf. §2) |
| Formes | `rounded-lg`, `rounded-xl`, `rounded-2xl`, `rounded-full` (sur badges, étapes, conteneurs, icônes) ; anneaux décoratifs `ring-1 ring-*` |
| Couleurs | `indigo-*`, `violet-*`, `purple-*`, `fuchsia-*`, `zinc-950` en panneau ; couleurs Tailwind brutes (`emerald-*`, `amber-*`, `red-*`) : passer par les tokens |
| Icônes | `Sparkles`, `Lightbulb`, `Wand*`, `Stars`, `Rocket`, `Trophy`, `Zap`, `Bot`, `MailCheck`, `ShieldCheck` décoratifs ; toute icône dans un rond ou carré coloré (`size-9…12` + fond) ; icône de plus de 16 px |
| Texte | `text-balance`, `text-pretty`, `tracking-tight`, sur-titres en capitales espacées (`uppercase tracking-wide`), phrases d'accroche (« sans perdre le fil », « en quelques secondes »), emoji, `font-medium` (la graisse 500 n'existe pas en Segoe UI : utiliser 400 ou 600) |
| Mise en page | cartes dans des cartes, grilles de « cartes de chiffres », états vides centrés avec grande icône, `py-10` et plus, `space-y-8` et plus, `max-w-6xl` centré sur les pages de données, panneau de présentation sur la page de connexion |
| Mouvement | `transition-*`, `animate-in`, `zoom-in-*`, `slide-in-*`, `group-hover:translate-*` (seul `animate-spin` du chargement reste) |

Critère de recette : la commande suivante ne renvoie **rien** (hors `components/ui/select.tsx`
pour `shadow-md`).

```bash
rg -n "gradient|blur|backdrop|rounded-(lg|xl|2xl|full)|shadow-(xs|sm|lg|xl)|\bshadow\b|indigo|violet|purple|fuchsia|emerald|amber|text-balance|text-pretty|tracking-tight|tracking-wide|font-medium|Sparkles|Lightbulb|Trophy|MailCheck|ShieldCheck|transition-|zoom-in|slide-in" src
```

### À utiliser

- Typographie système : `"Segoe UI", system-ui, …` ; graisses **400** et **600** uniquement.
- Rayons de 2 à 4 px (`rounded-sm` = 2 px, `rounded-md` = 3 px, `rounded-lg`/`xl` remappés à 4 px).
- Filets de 1 px : `border-border` pour les contours, `border-grid` pour le quadrillage.
- Fond blanc pour la donnée, gris clair (`bg-muted`) pour les zones d'interface (en-têtes de
  colonnes, numéros de ligne, barre d'état, fond de la page de connexion).
- Accent `bg-primary` sur **un seul** bouton par zone, sélection `bg-selection`, focus `outline-ring`.
- Icônes lucide fonctionnelles, 14 à 16 px, couleur du texte : `Search`, `ListFilter`,
  `ChevronDown`, `ChevronRight`, `ArrowUp`, `ArrowDown`, `X`, `Check`, `TriangleAlert`,
  `CircleAlert`, `CircleCheck`, `Info`, `LoaderCircle`, `FileUp`, `Plus`.
- Chiffres en `tabular-nums`, alignés à droite.

---

## 2. Tokens

### Choix de l'accent : bleu de bureau `#1F5FA8`

- Le vert est écarté : il entre en collision avec la couleur de **succès** et renvoie trop
  directement à l'identité d'un tableur connu.
- L'indigo/violet est écarté : c'est le réglage par défaut des interfaces générées.
- Un bleu désaturé (teinte ≈ 212°) est la couleur conventionnelle de la **sélection** et des
  **liens** dans les logiciels de bureau : l'accent, la sélection et le focus forment une seule
  famille, ce qui réduit le nombre de couleurs à l'écran.
- Contraste : 6,4:1 sur blanc (texte blanc sur fond accent : 6,4:1), 5,2:1 sur `--selection`.

### Couleurs (contrastes vérifiés sur `#FFFFFF` sauf mention)

| Token | Valeur | Rôle | Contraste |
|---|---|---|---|
| `--background` | `#FFFFFF` | Fond des données, des formulaires, des en-têtes d'application | — |
| `--foreground` | `#1F2328` | Texte principal | 15,8:1 |
| `--muted` | `#F2F3F5` | Surface d'interface : en-têtes de colonnes, numéros de ligne, barre d'état, fond de la page de connexion | — |
| `--muted-foreground` | `#5B6370` | Texte secondaire, libellés d'aide | 6,1:1 (5,5:1 sur `--muted`) |
| `--border` | `#C9CED5` | Contours de conteneurs, séparateurs, ligne de gel des colonnes | (décoratif) |
| `--grid-line` | `#DCDFE3` | Quadrillage interne des cellules | (décoratif) |
| `--input` | `#8C939D` | Bordure des champs, cases à cocher, boutons secondaires | 3,1:1 (≥ 3:1 exigé pour un composant) |
| `--primary` | `#1F5FA8` | Accent : bouton principal, lien, indicateur de tri, filtre actif | 6,4:1 |
| `--primary-hover` | `#194E8A` | Survol du bouton principal | 8,5:1 |
| `--ring` | `#1F5FA8` | Contour de focus (2 px) | 6,4:1 |
| `--accent` | `#E9EBEE` | Survol des boutons secondaires, des éléments de menu | — |
| `--selection` | `#DCE8F6` | Numéro de ligne et en-tête de colonne de la cellule active, sélection de texte | primary : 5,2:1 |
| `--selection-row` | `#EEF3FA` | Fond de la ligne active | foreground : 14,4:1 |
| `--row-hover` | `#F6F8FA` | Survol d'une ligne | — |
| `--destructive` | `#B42318` | Texte et icône d'erreur, bouton destructif | 6,4:1 |
| `--destructive-bg` | `#FDECEA` | Fond d'un message d'erreur | destructive : 5,7:1 |
| `--destructive-border` | `#F0B3AC` | Contour d'un message d'erreur | — |
| `--warning` | `#8A5A00` | Texte et icône d'avertissement, marqueur de cellule | 5,9:1 (5,4:1 sur `--warning-bg`) |
| `--warning-bg` | `#FFF4D6` | Fond d'un message d'avertissement | — |
| `--warning-border` | `#E0B54A` | Contour d'un message d'avertissement | — |
| `--success` | `#1E6B3A` | Texte et icône de succès | 6,4:1 (5,8:1 sur `--success-bg`) |
| `--success-bg` | `#E8F4EC` | Fond d'un message de succès | — |
| `--success-border` | `#9CCBAB` | Contour d'un message de succès | — |

Aucune information ne repose sur la couleur seule : chaque état coloré a un texte ou une icône.

### Typographie

| Usage | Taille / interligne | Graisse | Classe |
|---|---|---|---|
| Titre de page (`h1`) | 18 px / 24 px | 600 | `text-lg font-semibold` |
| Titre de section, de formulaire, d'onglet actif (`h2`) | 14 px / 20 px | 600 | `text-sm font-semibold` |
| Texte courant, messages, champs de connexion | 14 px / 20 px | 400 | `text-sm` |
| Grille, boutons, champs des barres d'outils, libellés | 13 px / 18 px | 400 | `text-ui` (token ajouté) |
| En-têtes de colonnes | 12 px / 16 px | 600 | `text-xs font-semibold` |
| Barre d'état, fil d'Ariane, aides sous les champs | 12 px / 16 px | 400 | `text-xs` |

Police : `"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`.
Chiffres : `tabular-nums` sur toute colonne numérique ou date. Pas d'espacement de lettres.

### Espacements, tailles, rayons

| Élément | Valeur | Classe |
|---|---|---|
| Unité | 4 px (échelle Tailwind) | — |
| Marge de page | 16 px horizontal, 12 px vertical | `px-4 py-3` |
| Écart entre blocs d'une page | 12 px (max 24 px) | `space-y-3` (max `space-y-6`) |
| Écart libellé → champ | 4 px | `space-y-1` |
| Écart entre champs d'un formulaire | 12 px | `gap-3` / `space-y-3` |
| En-tête d'application | 40 px | `h-10` |
| Barre d'outils de grille | 40 px | `h-10` |
| Ligne de grille (corps et en-tête) | 28 px, filet compris | `h-7` |
| Barre d'état | 24 px | `h-6` |
| Contrôles (boutons, champs, listes) | 32 px ; petit : 28 px ; page de connexion : 36 px | `h-8` / `h-7` / `h-9` |
| Padding horizontal d'une cellule | 8 px | `px-2` |
| Rayon des contrôles et conteneurs | 2 à 4 px | `rounded-sm` / `rounded-md` |
| Cible cliquable minimale | 24 × 24 px (WCAG 2.2, 2.5.8) | — |

### Focus visible

- Partout : contour **2 px plein `--ring`, décalé de 1 px** (`outline-offset: 1px`).
- Dans la grille : même contour, **intérieur** (`outline-offset: -2px`) pour ne pas déborder
  sur la cellule voisine.
- Aucun `ring-4` translucide, aucun `outline-ring/50`.

### Bloc à coller dans `styles/globals.css`

Remplacer le bloc `:root { … }`, le bloc `@theme inline { … }` et le `@layer base { … }`
existants par ce qui suit. Les noms shadcn sont conservés et remappés ; le bloc `.dark` reste
en place, inutilisé (pas de mode sombre en V1, cf. §8).

```css
:root {
  /* Surfaces et texte */
  --background: #ffffff;
  --foreground: #1f2328;
  --card: #ffffff;
  --card-foreground: #1f2328;
  --popover: #ffffff;
  --popover-foreground: #1f2328;
  --muted: #f2f3f5;
  --muted-foreground: #5b6370;
  --secondary: #f2f3f5;
  --secondary-foreground: #1f2328;

  /* Accent unique : bleu de bureau */
  --primary: #1f5fa8;
  --primary-hover: #194e8a;
  --primary-foreground: #ffffff;
  --accent: #e9ebee; /* survol neutre (shadcn : « accent ») */
  --accent-foreground: #1f2328;
  --ring: #1f5fa8;

  /* Filets */
  --border: #c9ced5;
  --input: #8c939d;
  --grid-line: #dcdfe3;

  /* Grille et sélection */
  --grid-header: #f2f3f5;
  --selection: #dce8f6;
  --selection-row: #eef3fa;
  --row-hover: #f6f8fa;

  /* États */
  --destructive: #b42318;
  --destructive-foreground: #ffffff;
  --destructive-bg: #fdecea;
  --destructive-border: #f0b3ac;
  --warning: #8a5a00;
  --warning-bg: #fff4d6;
  --warning-border: #e0b54a;
  --success: #1e6b3a;
  --success-bg: #e8f4ec;
  --success-border: #9ccbab;

  /* Conservés pour compatibilité (non utilisés en V1) */
  --chart-1: #1f5fa8;
  --chart-2: #1e6b3a;
  --chart-3: #8a5a00;
  --chart-4: #5b6370;
  --chart-5: #b42318;
  --sidebar-background: #f2f3f5;
  --sidebar-foreground: #1f2328;
  --sidebar-primary: #1f5fa8;
  --sidebar-primary-foreground: #ffffff;
  --sidebar-accent: #e9ebee;
  --sidebar-accent-foreground: #1f2328;
  --sidebar-border: #c9ced5;
  --sidebar-ring: #1f5fa8;

  --radius: 3px;
}

@theme {
  --font-sans: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
  --font-mono: Consolas, "Cascadia Mono", ui-monospace, monospace;

  /* 13 px : grille, boutons, champs, libellés */
  --text-ui: 0.8125rem;
  --text-ui--line-height: 1.125rem;

  /* Ombres neutralisées ; une seule ombre courte pour les menus flottants */
  --shadow-2xs: 0 0 #0000;
  --shadow-xs: 0 0 #0000;
  --shadow-sm: 0 0 #0000;
  --shadow-md: 0 2px 6px rgb(0 0 0 / 0.16);
  --shadow-lg: 0 2px 6px rgb(0 0 0 / 0.16);
  --shadow-xl: 0 2px 6px rgb(0 0 0 / 0.16);
  --shadow-2xl: 0 2px 6px rgb(0 0 0 / 0.16);
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-hover: var(--primary-hover);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-destructive-bg: var(--destructive-bg);
  --color-destructive-border: var(--destructive-border);
  --color-warning: var(--warning);
  --color-warning-bg: var(--warning-bg);
  --color-warning-border: var(--warning-border);
  --color-success: var(--success);
  --color-success-bg: var(--success-bg);
  --color-success-border: var(--success-border);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-grid: var(--grid-line);
  --color-grid-header: var(--grid-header);
  --color-selection: var(--selection);
  --color-selection-row: var(--selection-row);
  --color-row-hover: var(--row-hover);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-sidebar: var(--sidebar-background);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);

  /* Rayons : 2 à 4 px, jamais plus */
  --radius-xs: 2px;
  --radius-sm: 2px;
  --radius-md: 3px;
  --radius-lg: 4px;
  --radius-xl: 4px;
  --radius-2xl: 4px;
  --radius-3xl: 4px;

  --animate-accordion-down: accordion-down 0.2s ease-out;
  --animate-accordion-up: accordion-up 0.2s ease-out;
  /* (conserver les @keyframes accordion-* existants) */
}

@layer base {
  * {
    @apply border-border outline-ring;
  }
  body {
    @apply bg-background text-foreground font-sans text-sm;
  }
  :focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 1px;
  }
  ::selection {
    background: var(--selection);
    color: var(--foreground);
  }
  input[type="checkbox"],
  input[type="radio"] {
    accent-color: var(--primary);
  }
}
```

Utilisation : `text-ui`, `bg-muted`, `border-grid`, `bg-grid-header`, `bg-selection`,
`bg-selection-row`, `hover:bg-row-hover`, `text-warning`, `bg-warning-bg`,
`border-warning-border`, `text-success`, `bg-destructive-bg`, `hover:bg-primary-hover`.

`src/index.css` reste tel quel (le `@media (prefers-reduced-motion)` est conservé).

---

## 3. Composants `ui/` (shadcn) : modifications

Modifications minimales mais nécessaires (justification : retirer ombres, gros rayons et
anneaux translucides ; à mentionner dans le commit).

### `src/components/ui/button.tsx`

Base :
```
inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border text-ui font-normal
disabled:pointer-events-none disabled:opacity-50
[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0
focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring
```
| Variante | Classes |
|---|---|
| `default` | `border-primary bg-primary text-primary-foreground font-semibold hover:bg-primary-hover hover:border-primary-hover` |
| `outline` | `border-input bg-background text-foreground hover:bg-accent` |
| `secondary` | `border-border bg-muted text-foreground hover:bg-accent` |
| `ghost` | `border-transparent bg-transparent hover:bg-accent` |
| `destructive` | `border-destructive bg-destructive text-destructive-foreground font-semibold hover:bg-[#9a1e14]` |
| `link` | `h-auto border-transparent px-0 text-primary underline underline-offset-2 hover:no-underline` |

| Taille | Classes |
|---|---|
| `default` | `h-8 px-3` |
| `sm` | `h-7 px-2` |
| `lg` | `h-9 px-4 text-sm` (connexion uniquement) |
| `icon` | `size-8` |

Supprimer : `shadow-*`, `ring-*`, `transition-*`, `outline-ring/50`, `has-[>svg]:px-*`.

### `src/components/ui/input.tsx`

```
flex h-8 w-full min-w-0 rounded-sm border border-input bg-background px-2 text-base md:text-ui
placeholder:text-muted-foreground
focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring focus-visible:border-ring
aria-invalid:border-destructive
disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-70
file:border-0 file:bg-transparent file:text-ui
```
Supprimer `shadow-xs`, `ring-*`, `transition-*`, les variantes `dark:`.

### `src/components/ui/select.tsx`

- Trigger : mêmes classes que l'input + `items-center justify-between gap-2`.
- Content : `rounded-sm border bg-popover shadow-md` ; **retirer** toutes les classes
  `animate-in/out`, `fade-*`, `zoom-*`, `slide-in-*`.
- Item : `rounded-none py-1 pl-2 pr-8 text-ui focus:bg-accent`.

### `src/components/ui/label.tsx`

`text-ui font-normal text-foreground leading-none` (au lieu de `text-sm font-medium`).

### `src/components/ui/card.tsx`

`rounded-sm border bg-card` (sans ombre), `CardHeader` `p-4 gap-1`, `CardContent` `p-4 pt-0`,
`CardFooter` `p-4 pt-0`. Usage restreint : aucun écran de cette spécification n'en a besoin ;
ne jamais imbriquer une `Card` dans un conteneur bordé.

---

## 4. Composant « grille de données »

### 4.1 Fichiers

| Fichier | Rôle |
|---|---|
| `src/domain/grid.ts` | **Pur** : recherche, filtres, tri, valeurs distinctes, tranches de budget, mois. Testé dans `tests/unit/grid.test.ts`. |
| `src/components/data-grid/DataGrid.tsx` | Tableau, navigation clavier, cellule active, ligne figée, colonnes gelées, états de corps (chargement, vide). |
| `src/components/data-grid/ColumnHeader.tsx` | Libellé triable + bouton de filtre. |
| `src/components/data-grid/ColumnFilterMenu.tsx` | Menu de filtre par colonne (tri + cases à cocher). |
| `src/components/data-grid/GridToolbar.tsx` | Barre d'outils au-dessus de la grille. |
| `src/components/data-grid/CellReadout.tsx` | Zone de lecture de la cellule active. |
| `src/components/data-grid/StatusBar.tsx` | Barre d'état sous la grille. |
| `src/components/Popover.tsx` | Panneau flottant générique (portail, position, fermeture). |

### 4.2 Définition des colonnes (contrat)

```ts
type ColumnKind = "ref" | "text" | "number" | "date" | "flags";
type FilterMode = "values" | "budget-ranges" | "months" | "flags";

type GridColumn<Row> = {
  key: string;
  label: string;                         // libellé d'en-tête, français
  width: number;                         // px, fixe (table-fixed + <colgroup>)
  kind: ColumnKind;                      // détermine alignement, tri et libellés de tri
  value: (row: Row) => string | number | null;   // valeur triable / filtrable ; null = vide
  render?: (row: Row) => ReactNode;      // affichage (par défaut : value formatée)
  text?: (row: Row) => string;           // texte complet pour la zone de lecture, le title et Ctrl+C
  sortable?: boolean;                    // défaut true
  filter?: FilterMode | false;           // défaut false
  frozen?: boolean;                      // colonne gelée à gauche (après les numéros de ligne)
  cellFlags?: (row: Row) => string[];    // libellés d'avertissement → marqueur de coin
};
```

Alignement déduit de `kind` : `ref` et `text` à gauche ; `number` et `date` **à droite** ;
`flags` à gauche.

### 4.3 Anatomie (de haut en bas)

```
┌ Barre d'outils (h-10) ─────────────────────────────────────────────────────────────┐
│ [Importer un fichier]  │  [Rechercher…            x]  [Filtrer (2) v]  [Effacer les filtres] │
├ Zone de lecture (min-h-7) ─────────────────────────────────────────────────────────┤
│ IDEA-012 │ Titre : Réduire la consommation des compresseurs d'air du site de Lyon   │
├────┬──────────┬────────────────────────┬──────────────┬─────┬───────┬─────────┬───┤
│    │ Réf. ↑ ▾ │ Titre                ▾ │ Direction  ▾ │ … ▾ │ Budget▾│ Date  ▾ │ …│  ← en-tête figé
├────┼──────────┼────────────────────────┼──────────────┼─────┼───────┼─────────┼───┤
│  1 │ IDEA-001 │ …                      │ Production   │     │ 40 000 €│12/03/2026│  │
│  2 │ IDEA-002 │ …                      │ ◤            │     │         │          │! │  ← ligne active
└────┴──────────┴────────────────────────┴──────────────┴─────┴───────┴─────────┴───┘
├ Barre d'état (h-6) ────────────────────────────────────────────────────────────────┤
│ 40 idées · 12 affichées · Filtres : Direction, Thème · Tri : Réf., de A à Z   Somme des budgets affichés : 1 240 000 € │
```

Mise en page : la grille occupe toute la hauteur restante. Conteneur :
`flex min-h-0 flex-1 flex-col border border-border bg-background` ; à l'intérieur, la barre
d'outils et la zone de lecture (`shrink-0`), la zone défilante
`relative min-h-0 flex-1 overflow-auto scroll-pt-7 scroll-pl-[140px]`, puis la barre d'état
(`shrink-0`).

### 4.4 Barre d'outils (`GridToolbar`)

`flex h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background px-2`

Ordre, de gauche à droite :
1. **Action de la page** (slot `actions`) : un seul bouton `default` (ex. « Importer un fichier »,
   « Nouveau challenge »), suivi d'un séparateur vertical `h-5 w-px bg-border`.
2. **Recherche** : `Input` `h-7 w-64 pl-7 pr-7` dans un conteneur `relative` ; icône `Search`
   `size-3.5 text-muted-foreground` à gauche (`absolute left-2`) ; bouton `X` « Effacer la
   recherche » à droite quand le champ n'est pas vide. Libellé caché : « Rechercher dans les
   idées ». Placeholder : « Rechercher… ». Recherche insensible à la casse et aux accents
   (`normalizeText` de `src/domain/text.ts`), sur toutes les colonnes `text`/`ref` affichées.
   `Échap` vide le champ. Pas de délai (≤ quelques centaines de lignes).
3. **Filtrer** : bouton `outline` `sm`, icône `ListFilter`, libellé « Filtrer » ou
   « Filtrer (2) » quand 2 colonnes sont filtrées (c'est le **compteur** de la barre d'outils).
   Ouvre un menu (`Popover`) listant les colonnes filtrables ; chaque entrée porte une coche
   `Check` si la colonne est filtrée. Choisir une colonne ouvre son menu de filtre, ancré sur son
   en-tête. Rôle : rendre le filtre découvrable sans viser la petite flèche d'en-tête.
4. **Effacer les filtres** : bouton `ghost` `sm`, désactivé s'il n'y a ni filtre ni recherche ;
   efface filtres **et** recherche, conserve le tri.

### 4.5 Zone de lecture (`CellReadout`)

Équivalent de la barre de contenu d'un tableur : affiche en entier ce que la cellule active
tronque.

`flex min-h-7 shrink-0 border-b border-border text-ui`
- Case de gauche `w-24 shrink-0 border-r border-border bg-muted px-2 py-1 font-semibold tabular-nums` :
  la **Réf.** de la ligne active.
- Case de droite `min-w-0 flex-1 px-2 py-1 whitespace-pre-wrap break-words` :
  `« {libellé de colonne} : {texte complet} »` ; pour « Points d'attention », la liste complète
  séparée par « ; ».
- Vide si aucune cellule active. `aria-live="off"` (pas d'annonce à chaque déplacement).

### 4.6 Tableau

```html
<table role="grid" aria-label="Idées du challenge" aria-rowcount={n + 1} aria-colcount={…}
       class="w-max min-w-full table-fixed border-separate border-spacing-0 text-ui">
  <colgroup> <col style="width:44px" /> … </colgroup>
```

`border-separate border-spacing-0` est obligatoire (avec `border-collapse`, les filets
disparaissent sur les cellules collantes). Les filets sont portés par les cellules :
`border-b border-r border-grid`.

**Colonne de numéros de ligne** (première, 44 px) :
`<th scope="row">` `sticky left-0 z-10 border-b border-r border-border bg-muted px-2 text-right text-xs text-muted-foreground tabular-nums`.
Le numéro est la **position d'affichage** (1…n après tri et filtre), pas un identifiant : la
Réf. reste l'identifiant. Ligne active : `bg-selection text-primary font-semibold`. Clic sur le
numéro = rend active la première cellule de données de la ligne.

**Ligne d'en-tête figée** : chaque `th` est
`sticky top-0 z-20 h-7 border-b border-r border-border bg-grid-header px-2 text-xs font-semibold text-foreground`.
La case d'angle (au-dessus des numéros) : `sticky left-0 top-0 z-30 bg-muted`.
En-tête de la colonne de la cellule active : `bg-selection`.

**Colonnes gelées** (`frozen`, en pratique Réf.) : `sticky left-[44px] z-10 bg-background` ;
la dernière colonne gelée porte `border-r border-r-border` (filet plus foncé = ligne de gel).
Les en-têtes gelés ont `z-30`.

**Cellules** : `h-7 max-w-0 truncate whitespace-nowrap border-b border-r border-grid px-2 align-middle`
+ `text-right tabular-nums` pour `number`/`date`. Chaque cellule tronquable porte un `title`
avec son texte complet.

**Cellule vide** : rien d'affiché (convention tableur), avec `<span class="sr-only">Vide</span>`.
Aucun tiret « — ».

**Survol** : `tr:hover > td` → `bg-row-hover`.
**Ligne active** : `aria-selected="true"` sur le `tr`, cellules `bg-selection-row` (cellules
gelées comprises, elles doivent repeindre leur fond).
**Cellule active** : `tabIndex=0`, `outline-2 -outline-offset-2 outline-ring` (même sans focus
clavier, pour que la sélection reste visible quand le focus est ailleurs : dans ce cas
`outline-input`).

**Cellule d'avertissement** (`cellFlags` non vide) : marqueur de coin en haut à droite, triangle
de 6 px couleur avertissement, plus le libellé dans le `title` et dans la zone de lecture :
```
relative after:pointer-events-none after:absolute after:right-0 after:top-0 after:size-0
after:border-l-[6px] after:border-l-transparent after:border-t-[6px] after:border-t-warning
```
La colonne « Points d'attention » donne la même information en texte (la couleur n'est jamais
seule) : icône `TriangleAlert size-3.5 text-warning` + premier libellé + « (+n) » s'il y en a
plusieurs, texte `text-warning`.

**Montants** : `new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 })`
→ « 40 000 € », aligné à droite. Si `budget_eur` est `null` mais `budget_raw` existe : afficher
`budget_raw` en `text-muted-foreground`, aligné à droite, avec le marqueur de coin.
**Dates** : `Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" })`
→ « 12/03/2026 », aligné à droite.

### 4.7 En-têtes triables (`ColumnHeader`)

Contenu du `th` : `flex h-full items-center gap-1`.
- **Bouton de tri** (le libellé) : `flex min-w-0 flex-1 items-center gap-1 text-left` (à droite
  pour `number`/`date` : `justify-end`), `title="Cliquer pour trier"`. Un clic fait tourner :
  croissant → décroissant → aucun tri (retour au tri par défaut). **Une seule colonne de tri à la
  fois.**
- **Indicateur** : `ArrowUp` (croissant) ou `ArrowDown` (décroissant), `size-3 text-primary`,
  après le libellé ; rien sur les colonnes non triées. `aria-sort="ascending" | "descending"` sur
  le `th` trié uniquement.
- **Bouton de filtre** (colonnes filtrables) : carré `size-5 rounded-sm border border-input bg-background`
  à droite, icône `ChevronDown size-3`. Filtre actif : icône `ListFilter size-3 text-primary`,
  bordure `border-primary`, et le `th` passe en `bg-selection`. `aria-label="Filtrer la colonne Direction"`,
  `aria-haspopup="dialog"`, `aria-expanded`.

Règles de tri (dans `domain/grid.ts`) :
- Texte : `Intl.Collator("fr", { sensitivity: "base", numeric: true })` (« IDEA-2 » avant « IDEA-10 »).
- Nombres et dates : numérique.
- **Les vides sont toujours en dernier**, dans les deux sens (convention tableur).
- Départage stable par Réf. croissante.
- Tri par défaut : Réf., croissant (non affiché comme tri actif dans les en-têtes, mais indiqué
  dans la barre d'état).

### 4.8 Menu de filtre par colonne (`ColumnFilterMenu`)

Panneau `Popover` de 264 px : `w-66 rounded-sm border border-border bg-popover p-1 text-ui shadow-md`,
`role="dialog"`, `aria-label="Filtre de la colonne Direction"`.

Contenu, de haut en bas :
1. **Tri** (deux éléments de menu, `h-7 px-2 hover:bg-accent text-left w-full`, icône
   `ArrowUp`/`ArrowDown size-3.5`). Libellés selon le type :
   - texte : « Trier de A à Z » / « Trier de Z à A »
   - nombre : « Trier du plus petit au plus grand » / « Trier du plus grand au plus petit »
   - date : « Trier du plus ancien au plus récent » / « Trier du plus récent au plus ancien »
   Le choix applique le tri et ferme le menu.
2. Séparateur `my-1 h-px bg-border`.
3. **« Effacer le filtre de « Direction » »** : désactivé si la colonne n'est pas filtrée.
4. Séparateur.
5. **Champ « Rechercher une valeur »** (`Input h-7`), qui réduit la liste ci-dessous.
6. **Liste de cases à cocher** : `max-h-60 overflow-auto rounded-sm border border-border py-1`,
   chaque ligne `flex h-6 items-center gap-2 px-2 hover:bg-accent` avec
   `<input type="checkbox" class="size-3.5">` + valeur + compte en `text-muted-foreground`
   (« Production (12) »).
   - Première ligne : **« (Tout sélectionner) »**, case à trois états (`indeterminate` via ref) ;
     agit sur les valeurs visibles après la recherche.
   - Valeurs distinctes triées de A à Z (ou numériquement/chronologiquement).
   - Dernière ligne : **« (Vides) »** si la colonne a des cellules vides.
   - Valeurs proposées : celles des lignes qui passent **les autres** filtres et la recherche
     (comportement du filtre automatique), plus les valeurs déjà cochées de cette colonne.
7. **Pied** : `flex justify-end gap-2 pt-2` avec « OK » (`default sm`, désactivé si aucune case
   n'est cochée) et « Annuler » (`outline sm`). Le filtre ne s'applique qu'à « OK ».

Valeurs par mode :
| Mode | Valeurs proposées |
|---|---|
| `values` | valeurs distinctes de la colonne |
| `budget-ranges` | « Moins de 10 000 € », « De 10 000 € à 50 000 € », « De 50 000 € à 100 000 € », « 100 000 € et plus », « Non chiffré » (texte libre sans montant), « (Vides) » |
| `months` | mois de dépôt, du plus récent au plus ancien : « mars 2026 », « février 2026 »…, « (Vides) » |
| `flags` | libellés de `rowWarningLabels` présents, puis « (Aucun point d'attention) » ; une idée passe si elle porte **au moins un** des points cochés |

Sémantique interne : un filtre de colonne = ensemble des valeurs **retenues** ; tout cocher =
pas de filtre (on supprime l'entrée).

Positionnement (`Popover`) : rendu via `createPortal(document.body)`, `position: fixed`, aligné
sous le bouton déclencheur (bord droit du panneau sur le bord droit du bouton), recadré dans la
fenêtre (8 px de marge), retourné au-dessus s'il manque de place en bas. Ferme sur `Échap`,
clic à l'extérieur, défilement de la grille et redimensionnement de la fenêtre. Le focus revient
au bouton déclencheur à la fermeture.

### 4.9 Barre d'état (`StatusBar`)

`flex h-6 shrink-0 items-center gap-3 border-t border-border bg-muted px-2 text-xs text-muted-foreground tabular-nums`,
`role="status" aria-live="polite"` (annonce seulement le compte).

Gauche, segments séparés par « · » :
- Sans filtre ni recherche : « 40 idées ».
- Avec filtre ou recherche : « 40 idées · 12 affichées ».
- « Filtres : Direction, Thème » si au moins un filtre ; « Recherche : « compresseur » » si une
  recherche est active.
- « Tri : Budget, du plus grand au plus petit » (toujours affiché, y compris le tri par défaut
  « Tri : Réf., de A à Z »).

Droite (`ml-auto`), propre à chaque écran :
- Idées : « Somme des budgets affichés : 1 240 000 € (9 non chiffrés) ».
- Import : « 38 idées seront importées sur 40 ».

### 4.10 Clavier et souris

La grille est **un seul arrêt de tabulation** (focus mobile : seule la cellule active a
`tabIndex=0`). La barre d'outils et la barre d'état sont en dehors.

| Touche | Effet |
|---|---|
| `Tab` / `Maj+Tab` | Entre dans la grille sur la cellule active (la première cellule de données au départ) / en sort |
| `↑ ↓ ← →` | Déplace la cellule active ; `↑` depuis la 1re ligne monte sur l'en-tête |
| `Début` / `Fin` | Première / dernière cellule de la ligne |
| `Ctrl+Début` / `Ctrl+Fin` | Première / dernière cellule de la grille |
| `Page préc.` / `Page suiv.` | Monte / descend du nombre de lignes visibles |
| `Entrée` ou `Espace` sur un en-tête | Fait tourner le tri de la colonne |
| `Alt+↓` sur un en-tête | Ouvre le menu de filtre de la colonne |
| `Espace` sur une cellule case à cocher | Coche / décoche (écran d'import) |
| `Entrée` sur une ligne | Ouvre l'élément si la ligne est ouvrable (liste des challenges) ; sinon sans effet |
| `Ctrl+C` | Copie le texte complet de la cellule active (`navigator.clipboard.writeText`) |
| Dans un menu de filtre : `↑ ↓` | Parcourt les cases ; `Espace` coche ; `Entrée` = OK ; `Échap` = Annuler |

La cellule active est ramenée dans la vue par `scrollIntoView({ block: "nearest", inline: "nearest" })` ;
`scroll-pt-7 scroll-pl-[140px]` sur le conteneur évite qu'elle se cache sous l'en-tête figé ou
les colonnes gelées.

Souris : clic sur une cellule = cellule active ; clic sur un numéro de ligne = ligne active.
Pas de redimensionnement ni de déplacement de colonnes en V1.

État : tri, filtres, recherche et cellule active vivent dans l'état React de la page (perdus à
la navigation). Pas de persistance en V1 (hypothèse la plus simple, à noter dans le README).

Performance : pas de virtualisation (quelques centaines de lignes) ; à reconsidérer seulement sur
symptôme mesuré.

### 4.11 États du corps de grille

L'en-tête et la barre d'outils restent visibles dans tous les états ; le message occupe une
ligne `<td colSpan>` `px-3 py-4 text-sm`, aligné à gauche.

| État | Contenu |
|---|---|
| Chargement | `LoaderCircle size-4 animate-spin` + « Chargement des idées… » (`text-muted-foreground`) |
| Vide (aucune donnée) | Texte propre à l'écran + bouton d'action (cf. §5) |
| Vide (filtres) | « Aucune idée ne correspond à la recherche ou aux filtres. » + bouton `outline sm` « Effacer les filtres » |
| Erreur | Pas de grille : `ErrorBlock` (message + « Réessayer ») à la place |

### 4.12 Tableau des idées (page challenge)

| # | Colonne | Largeur | Type | Tri | Filtre | Remarques |
|---|---|---|---|---|---|---|
| — | (numéros) | 44 | — | non | non | gelée |
| 1 | **Réf.** | 96 | `ref` | oui (défaut, A→Z) | non | gelée ; `external_ref` |
| 2 | **Titre** | 360 | `text` | oui | non | couvert par la recherche ; marqueur si `description_courte` |
| 3 | **Direction** | 160 | `text` | oui | `values` | marqueur si `direction_manquante` |
| 4 | **Site** | 140 | `text` | oui | `values` | marqueur si `site_manquant` |
| 5 | **Thème** | 160 | `text` | oui | `values` | marqueur si `theme_manquant` |
| 6 | **Budget** | 112 | `number` | oui | `budget-ranges` | `budget_eur` ; `title` = `budget_raw` ; marqueur si `budget_*` |
| 7 | **Date de dépôt** | 112 | `date` | oui | `months` | `submitted_at` ; marqueur si `date_*` |
| 8 | **Points d'attention** | 240 | `flags` | oui (par nombre de points, décroissant d'abord) | `flags` | `quality_flags` → `rowWarningLabels` |

La correspondance « point d'attention → colonne marquée » est déclarée dans la feature
(`src/features/ideas/ideaColumns.ts`), pas dans le domaine. `auteur_manquant` et
`cellule_formule` n'ont pas de colonne : ils n'apparaissent que dans « Points d'attention ».

---

## 5. Écran par écran

### 5.0 Structure commune (`AppShell`)

```
<div class="flex h-dvh flex-col bg-background">
  <header class="flex h-10 shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-4">
  <main class="flex min-h-0 flex-1 flex-col overflow-auto">  <Outlet/>  </main>
</div>
```

- Plus de `sticky … bg-background/85 backdrop-blur`, plus de `max-w-6xl` centré, plus de
  `bg-muted/30`, plus de `py-10`.
- Gauche : `AppName` (cf. §6) : « Challenge Innovation » `text-sm font-semibold`, puis
  « Espace évaluateur » `text-xs text-muted-foreground`, séparés par un filet vertical
  `h-4 w-px bg-border mx-2`, sur une seule ligne. Lien vers `/`. Pas d'icône.
- Droite : adresse e-mail `text-xs text-muted-foreground truncate max-w-64` (masquée sous
  `sm`), puis bouton `ghost sm` « Se déconnecter » (sans icône). Pendant la déconnexion :
  « Déconnexion… », désactivé.
- Les pages de données (`ChallengesPage`, `ChallengePage`, étape 2 de l'import) occupent toute la
  hauteur (`flex min-h-0 flex-1 flex-col`) : seule la grille défile. Les pages de formulaire
  défilent normalement et limitent leur contenu à `max-w-2xl`.

### 5.0 bis En-tête de page (`PageHeader`)

`shrink-0 space-y-1 px-4 pt-3 pb-2` :
- Fil d'Ariane `nav aria-label="Fil d'Ariane"` en `text-xs text-muted-foreground`, éléments
  séparés par `ChevronRight size-3`, liens `hover:underline`, dernier élément non lié avec
  `aria-current="page"`.
- Ligne titre : `flex flex-wrap items-baseline gap-x-3` : `h1` `text-lg font-semibold`, puis
  métadonnées `text-xs text-muted-foreground` (« Client : Hexavia · Jury le 12/06/2026 »).
- Pas de sur-titre en capitales, pas de phrase d'accroche.

### 5.1 Connexion (`AuthLayout` + `LoginPage`)

**Disparaît** : le panneau sombre `aside` (halos indigo/ambre, titre marketing, liste des 4
étapes avec icônes, mention `ShieldCheck`), la grille deux colonnes, `BrandMark` avec ampoule.

**Disposition** :
```
<div class="flex min-h-dvh flex-col bg-muted">
  <header class="flex h-10 items-center border-b border-border bg-background px-4"> <AppName/> </header>
  <main class="flex flex-1 justify-center px-4 pt-[12vh]">
    <div class="w-full max-w-[360px]">
      <div class="rounded-sm border border-border bg-background p-6"> {children} </div>
      <p class="mt-3 text-xs text-muted-foreground">
        Accès réservé aux évaluateurs invités. Un problème pour vous connecter ? Contactez l'administrateur de la plateforme.
      </p>
    </div>
  </main>
</div>
```

**Étape e-mail** (`space-y-4`) :
- `h1` « Connexion » (`text-lg font-semibold`).
- Texte `text-sm text-muted-foreground` : « Saisissez votre adresse e-mail professionnelle. Vous
  recevrez un lien et un code de connexion ; aucun mot de passe n'est nécessaire. »
- Champ : libellé « Adresse e-mail », `Input h-9`, placeholder « prenom.nom@entreprise.fr ».
  Erreur de champ sous le champ : `text-xs text-destructive` (inchangé sur le fond).
- Erreur de formulaire : `Alert tone="error"`.
- Bouton `default lg w-full` « Recevoir le lien de connexion » (sans flèche). En cours :
  spinner `size-4` + « Envoi en cours… ».

**Étape code** (`space-y-4`) :
- **Disparaît** : le rond indigo avec `MailCheck`.
- `h1` « Saisissez le code reçu ».
- Texte : « Si l'adresse **{email}** est autorisée, un e-mail vient de lui être envoyé. Cliquez
  sur le lien qu'il contient ou saisissez le code ci-dessous. » (adresse en `font-semibold
  text-foreground break-all`).
- Champ « Code reçu par e-mail », `Input h-9 font-mono text-base tracking-[0.3em]`, aligné à
  gauche (plus de centrage), placeholder vide.
- Bouton `default lg w-full` « Se connecter » ; en cours « Vérification… ».
- Pied `flex justify-between border-t border-border pt-3 text-ui` : « Changer d'adresse »
  (`link`, sans icône) à gauche, « Renvoyer l'e-mail » / « Renvoyer l'e-mail (42 s) » à droite
  (`link`, désactivé = `text-muted-foreground no-underline`).
- Aide `text-xs text-muted-foreground` : « Rien reçu après quelques minutes ? Vérifiez vos
  courriers indésirables. »
- Succès de renvoi : `Alert tone="success"` « Un nouvel e-mail vient d'être envoyé. »

Les messages d'erreur de `src/lib/messages.ts` sont inchangés.

### 5.2 Retour de lien (`AuthCallbackPage`)

Même `AuthLayout`.
- **Chargement** : ligne `flex items-center gap-2 text-sm text-muted-foreground`,
  `LoaderCircle size-4 animate-spin` + « Connexion en cours… ».
- **Erreur** : `h1` « Connexion impossible », `Alert tone="error"` avec le message, bouton
  `default lg w-full` « Recevoir un nouveau lien ».

`ConfigErrorScreen` adopte la même boîte (sans en-tête d'application) : `h1` « L'application
n'est pas disponible » + `Alert`. `FullPageLoader` : spinner `size-4`, texte `text-sm`.

### 5.3 Liste des challenges (`ChallengesPage`)

**Disparaît** : la grille de cartes `rounded-xl`, le chevron animé, le sur-titre client en
capitales, l'`EmptyState` centré avec icône dossier.

**Disposition** : `PageHeader` (fil d'Ariane absent, `h1` « Challenges ») puis une `DataGrid`
pleine hauteur.

Barre d'outils : `actions` = bouton `default` `Plus` « Nouveau challenge » ; recherche
(« Rechercher un challenge ») ; pas de bouton « Filtrer » ni « Effacer les filtres » si aucune
colonne n'est filtrable — ici Client l'est, donc les deux sont présents.

| Colonne | Largeur | Type | Tri | Filtre |
|---|---|---|---|---|
| (numéros) | 44 | — | — | — |
| **Challenge** | 320 | `text` (gelée) | oui | non |
| **Client** | 200 | `text` | oui | `values` |
| **Idées** | 80 | `number` | oui | non |
| **Date du jury** | 112 | `date` | oui | non |
| **Créé le** | 112 | `date` | oui (défaut : du plus récent au plus ancien) | non |

- La cellule « Challenge » contient un `Link` (`text-primary hover:underline`) vers
  `/challenges/:id` ; `Entrée` sur une ligne active l'ouvre aussi.
- « Idées » : afficher « 0 » quand il n'y a aucune idée (c'est une quantité, pas une donnée manquante).
- Barre d'état : « 3 challenges » (· « 1 affiché » si filtre).
- **Chargement** : corps de grille « Chargement des challenges… ».
- **Vide** : « Aucun challenge pour le moment. Créez-en un pour importer les idées des équipes. »
  + bouton `default sm` « Nouveau challenge ».
- **Erreur** : `ErrorBlock` sous le `PageHeader`.

### 5.4 Création de challenge (`NewChallengeForm`)

S'ouvre **au-dessus de la grille**, entre `PageHeader` et grille (la grille reste visible) :
`mx-4 mb-3 max-w-2xl rounded-sm border border-border bg-background p-4 space-y-3`.

- `h2` « Nouveau challenge » (`text-sm font-semibold`) ; aide `text-xs text-muted-foreground` :
  « Vous importerez ensuite le fichier des idées. »
- Deux champs côte à côte (`grid gap-3 sm:grid-cols-2`), libellé au-dessus (`space-y-1`) :
  « Nom du challenge » (placeholder « Ex. : Challenge innovation 2026 »), « Client »
  (placeholder « Ex. : Hexavia »). Focus automatique sur le premier champ.
- Erreurs de champ `text-xs text-destructive` ; erreur de formulaire `Alert tone="error"`.
- Boutons `flex gap-2` : `default` « Créer et importer les idées » (en cours : spinner +
  « Création… »), `outline` « Annuler ». `Échap` = Annuler.
- Pendant l'ouverture, le bouton « Nouveau challenge » de la barre d'outils est désactivé.

### 5.5 Page d'un challenge (`ChallengePage`)

**Disparaît** : le lien retour avec flèche, le sur-titre client en capitales, le tableau actuel
(`rounded-lg`, colonne « Idée » sur deux lignes, « Direction · site » fusionnées), l'`EmptyState`
avec icône `Inbox`.

**Disposition** :
- `PageHeader` : fil d'Ariane « Challenges › {titre} » ; `h1` = titre ; métadonnées
  « Client : {client} » + « · Jury le {date} » si `jury_date`.
- `DataGrid` des idées (colonnes §4.12), `aria-label="Idées du challenge"`.
- Barre d'outils : `actions` = `default` `FileUp` « Importer un fichier » (lien vers
  `/challenges/:id/import`) ; recherche « Rechercher… » ; « Filtrer » ; « Effacer les filtres ».
- Barre d'état : comptes, filtres, tri à gauche ; « Somme des budgets affichés : … (n non
  chiffrés) » à droite.

États :
- **Chargement du challenge** : `LoadingBlock` « Chargement du challenge… ».
- **Erreur challenge** : `ErrorBlock`.
- **Chargement des idées** : grille avec en-têtes, corps « Chargement des idées… ».
- **Vide** : corps : « Aucune idée dans ce challenge. Importez l'export du formulaire de dépôt
  (fichier CSV) : il sera vérifié avant tout enregistrement. » + bouton `default sm` « Importer un
  fichier ».
- **Erreur idées** : `ErrorBlock` à la place de la grille.

### 5.6 Import : structure et indicateur d'étapes

`PageHeader` : fil d'Ariane « Challenges › {titre} › Importer un fichier » ; `h1` « Importer un
fichier d'idées ». Sous le titre, l'indicateur d'étapes `ImportSteps` :

`<ol aria-label="Étapes de l'import" class="flex items-center gap-2 text-ui">` ; éléments
séparés par `ChevronRight size-3.5 text-muted-foreground` :
- « 1. Choisir le fichier » · « 2. Vérifier » · « 3. Terminé ».
- Étape courante : `font-semibold text-foreground border-b-2 border-primary pb-0.5`,
  `aria-current="step"`.
- Étape passée : `text-foreground` précédée de `Check size-3.5 text-success` (+ `sr-only`
  « terminée »).
- Étape à venir : `text-muted-foreground`.
- **Disparaît** : les pastilles `rounded-full`.

### 5.7 Import, étape 1 : choisir le fichier (`FileStep`)

`px-4 pb-4 max-w-2xl space-y-3`.

Zone de dépôt : `rounded-sm border border-dashed border-input bg-background px-4 py-8`,
contenu **aligné à gauche** :
- Ligne `flex items-center gap-2 text-sm` : `FileUp size-4 text-muted-foreground` +
  « Glissez le fichier CSV ici, ou » + bouton `outline sm` « Choisir un fichier… ».
- Survol de glisser : `border-primary bg-selection-row` (plus d'indigo).
- Analyse en cours : la ligne devient `LoaderCircle size-4 animate-spin` + « Analyse du fichier… »,
  bouton désactivé.

Sous la zone, tableau d'aide `dl` `grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs` :
| | |
|---|---|
| Format | CSV, séparateur point-virgule ou virgule |
| Taille | 5 Mo maximum |
| Colonnes obligatoires | identifiant, titre, description |
| Confidentialité | Le fichier est analysé sur votre ordinateur ; rien n'est enregistré avant votre validation. |

Erreur : `Alert tone="error"` sous la zone (messages existants inchangés).

### 5.8 Import, étape 2 : vérifier (`ReviewStep`)

**Disparaît** : les 4 cartes de chiffres `Stat`, les sections empilées avec icônes de titre,
les paires de doublons en cartes `rounded-lg` avec badges `rounded-full`, la barre fixe
`backdrop-blur`, `pb-24`.

**Disposition** (pleine hauteur, `flex min-h-0 flex-1 flex-col`) :

1. **Ligne de fichier** `px-4 pb-2 text-xs text-muted-foreground` :
   « Fichier : idees.csv · 42 lignes lues · 2 lignes vides ignorées (lignes 18, 31) · Colonnes
   non importées : commentaire, statut ». Segments absents s'ils sont à zéro.
2. **Alerte rejets** (si `rejected.length > 0`), `mx-4 mb-2` : `Alert tone="error"` « 2 lignes
   ne seront pas importées. Corrigez-les dans le fichier puis réimportez-le : les idées déjà
   enregistrées seront mises à jour, pas dupliquées. » + bouton `link` « Voir les lignes
   rejetées » (active l'onglet correspondant).
3. **Onglets** (`Tabs`, §6) collés à la grille, `px-4` :
   « Idées à importer (38) » · « Lignes rejetées (2) » · « Doublons possibles (3) » ·
   « Points d'attention (7) ». Un onglet dont le compte est 0 reste visible, désactivé.
   Compte des rejets en `text-destructive` avec `CircleAlert size-3.5` ; doublons et points
   d'attention en `text-warning` avec `TriangleAlert size-3.5`.
4. **Contenu de l'onglet** (grille pleine hauteur, `mx-4`).
5. **Barre d'actions** (dans le flux, pas `fixed`) :
   `flex shrink-0 items-center gap-3 border-t border-border bg-muted px-4 py-2` :
   `outline` « Changer de fichier » à gauche ; à droite `text-ui text-muted-foreground`
   « 38 idées seront importées sur 40 » puis `default` « Importer 38 idées » (désactivé à 0 ;
   en cours : spinner + « Enregistrement… »). Erreur d'enregistrement : `Alert tone="error"`
   juste au-dessus de cette barre.

**Onglet « Idées à importer »** : `DataGrid` avec les colonnes §4.12, précédées d'une colonne
**« Importer »** (40 px, gelée avant Réf.) : case à cocher par ligne
(`aria-label="Importer IDEA-012 — {titre}"`), case d'en-tête à trois états « Tout importer ».
Ligne décochée : texte `text-muted-foreground` (pas de barré). Tri, filtres et recherche
disponibles. Barre d'état à droite : « 38 idées seront importées sur 40 ». Les dates viennent
de `submittedAt`.

**Onglet « Lignes rejetées »** : `DataGrid` non filtrable :
| Colonne | Largeur | Type |
|---|---|---|
| Ligne du fichier | 96 | `number` (tri par défaut) |
| Réf. | 112 | `ref` (vide si « Sans identifiant ») |
| Titre | 320 | `text` |
| Problème | 360 | `text`, `text-destructive`, libellés `rowErrorLabels` joints par « ; » + « (voir ligne n) » le cas échéant |

**Onglet « Doublons possibles »** : texte d'introduction `text-xs text-muted-foreground mb-2` :
« Rien n'est fusionné automatiquement. Décochez une idée pour ne pas l'importer ; sinon, la
paire sera à trancher à l'étape Doublons. » Puis un tableau (même styles de cellule que la
grille, sans tri ni filtre), groupé par paire :
- Ligne de groupe `colSpan` `h-7 bg-muted px-2 text-xs font-semibold` : « Paire 1 · Contenu
  identique » ou « Paire 2 · Formulation proche (87 %) ». Pas de badge.
- Deux lignes, une par idée : Importer (case synchronisée avec l'onglet principal) · Réf. ·
  Titre · Extrait de description (`whitespace-normal line-clamp-3`, hauteur de ligne libre,
  `py-1`) · Direction · Site.

**Onglet « Points d'attention »** : tableau non filtrable :
| Colonne | Largeur | Type |
|---|---|---|
| Point d'attention | 320 | `text` (`rowWarningLabels`) |
| Idées | 72 | `number` (tri par défaut, décroissant) |
| Réf. concernées | 360 | `text` (jointes par « , ») |
| (action) | 140 | bouton `link` « Afficher ces idées » : ouvre l'onglet « Idées à importer » filtré sur ce point (filtre `flags`) |

Intro : « Ces idées seront importées ; les points sont conservés pour la suite de l'évaluation. »

### 5.9 Import, étape 3 : terminé (`DoneStep`)

**Disparaît** : la boîte centrée avec rond vert et icône.

`px-4 pb-4 max-w-2xl space-y-3`, aligné à gauche :
- `Alert tone="success" title="38 idées enregistrées"` : « Le fichier a été importé dans le
  challenge {titre}. »
- Tableau récapitulatif `table text-ui` avec filets `border-grid` (2 colonnes, chiffres à droite) :
  « Nouvelles idées » · « Idées mises à jour » · « Paires de doublons à examiner » (ligne absente
  si 0).
- Boutons : `default` « Voir les idées » (vers le challenge), `outline` « Importer un autre
  fichier » (revient à l'étape 1).

---

## 6. Composants partagés (`src/components/`)

| Fichier | Statut | Ce qu'il devient |
|---|---|---|
| `AppName.tsx` | **nouveau** (remplace `BrandMark` de `AuthLayout.tsx`) | Nom de l'application en texte, sans icône : « Challenge Innovation » (`text-sm font-semibold`) + filet + « Espace évaluateur » (`text-xs text-muted-foreground`). Prop `asLink`. |
| `AppShell.tsx` | modifié | §5.0 : en-tête 40 px plein, sans flou ; `main` pleine hauteur sans largeur maximale. |
| `PageHeader.tsx` | **nouveau** | Fil d'Ariane + `h1` + métadonnées (§5.0 bis). Props : `breadcrumb: { label, to? }[]`, `title`, `meta?: ReactNode`, `children?` (étapes d'import). |
| `Alert.tsx` | modifié | `flex gap-2 rounded-sm border px-3 py-2 text-sm text-foreground` ; tons : `error` → `border-destructive-border bg-destructive-bg`, icône `CircleAlert text-destructive` ; `warning` (**nouveau ton**) → `border-warning-border bg-warning-bg`, `TriangleAlert text-warning` ; `success` → `border-success-border bg-success-bg`, `CircleCheck text-success` ; `info` → `border-border bg-muted`, `Info text-muted-foreground`. Titre `font-semibold`, corps sans `opacity-90`. Nouvelle prop `action?: ReactNode` affichée à droite (`ml-auto`). Plus de `emerald-*`. |
| `PageStates.tsx` | modifié | `LoadingBlock` : `flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground`, spinner `size-4`. `ErrorBlock` : `px-4 py-3`, `Alert tone="error"` avec `action` = `outline sm` « Réessayer ». `EmptyState` : **prop `icon` supprimée** ; `rounded-sm border border-border bg-background px-4 py-4` aligné à gauche, titre `text-sm font-semibold`, texte `text-sm text-muted-foreground`, action `mt-3`. Utilisé hors grille uniquement (dans une grille, l'état vide est un corps de grille, §4.11). |
| `FullPageLoader.tsx` | modifié | Spinner `size-4`, texte `text-sm`. |
| `ConfigErrorScreen.tsx` | modifié | Même boîte que la connexion (§5.2), `h1` sans `tracking-tight`. |
| `Popover.tsx` | **nouveau** | Panneau flottant : `createPortal` vers `document.body`, `position: fixed` calculée depuis `anchorRef.getBoundingClientRect()`, recadrage dans la fenêtre, retournement vers le haut, fermeture sur `Échap` / clic extérieur / défilement / redimensionnement, retour du focus à l'ancre, premier élément focalisable focalisé à l'ouverture. Props : `open`, `onClose`, `anchorRef`, `align: "start" \| "end"`, `label`, `children`. Classes : `z-50 rounded-sm border border-border bg-popover p-1 text-ui shadow-md`. |
| `Tabs.tsx` | **nouveau** | Onglets accessibles sans dépendance : `role="tablist"`, `role="tab"` avec `aria-selected`/`aria-controls`, `role="tabpanel"` ; flèches gauche/droite + `Début`/`Fin` (activation automatique). Style « onglets de classeur » : liste `flex border-b border-border` ; onglet `h-8 px-3 text-ui border border-b-0 border-transparent -mb-px rounded-t-sm` ; actif `border-border bg-background font-semibold` ; inactif `text-muted-foreground hover:text-foreground hover:bg-accent` ; désactivé `opacity-50`. |
| `data-grid/*` | **nouveaux** | §4. |
| `ImportSteps` | **nouveau**, local à `features/import/` | §5.6 (remplace `Stepper`). |

Supprimés de `features/import/ImportPage.tsx` : `Stat`, `Section`, `Stepper`, `IdeaPreviewTable`
(remplacés par `DataGrid`, `Tabs`, `ImportSteps`).

Logique pure dans `src/domain/grid.ts` (+ `tests/unit/grid.test.ts`, noms de tests en
français). Un premier `grid.ts` existe déjà (`applyGridQuery`, `distinctValues`, `EMPTY_KEY`) : le compléter plutôt que le recréer, les noms ci-dessous sont indicatifs :
- `applyView(rows, columns, { search, filters, sort })` → lignes affichées ;
- `distinctValues(rows, column, otherFilters)` → `{ value, label, count }[]`, « (Vides) » en dernier ;
- `budgetRange(amount: number | null, raw: string | null)` et `monthKey(iso: string | null)` ;
- comparateur : vides en dernier dans les deux sens, départage stable par Réf.

Comportements à tester : tri croissant/décroissant avec vides en dernier ; tri naturel des Réf.
(« IDEA-2 » < « IDEA-10 ») ; tri stable sur égalités ; recherche insensible aux accents et à la
casse ; filtre « (Vides) » ; cumul de filtres sur plusieurs colonnes (ET) et de valeurs dans une
colonne (OU) ; filtre `flags` (au moins un point coché ; « (Aucun point d'attention) ») ;
valeurs distinctes calculées sur les lignes qui passent les autres filtres ; tranches de budget
aux bornes (10 000 € → « De 10 000 € à 50 000 € ») ; budget non chiffré ≠ vide.

---

## 7. Accessibilité (récapitulatif de recette)

- Contrastes : texte ≥ 4,5:1, composants et focus ≥ 3:1 (valeurs §2).
- Focus visible 2 px partout, intérieur dans la grille ; jamais `outline-none` sans remplaçant.
- Grille : `role="grid"`, `aria-rowcount`, `aria-colcount`, `aria-sort`, `aria-selected`,
  numéros en `th scope="row"`, focus mobile, raccourcis §4.10.
- Menus : `role="dialog"` + `aria-label`, `aria-expanded` sur le déclencheur, retour du focus.
- Toute couleur d'état est doublée d'un texte ou d'une icône (marqueurs de coin → colonne
  « Points d'attention » et zone de lecture).
- Cibles ≥ 24 px (bouton de filtre d'en-tête : 20 px visibles, zone cliquable étendue à 24 px
  par `before:absolute before:-inset-0.5`).
- Tous les champs ont un libellé (visible, ou `sr-only` pour la recherche).

## 8. Hors périmètre de cette spécification

- Mode sombre (le bloc `.dark` reste, non branché).
- Redimensionnement, masquage et réordonnancement de colonnes ; tri multi-colonnes ;
  persistance des vues.
- Écrans Notation, Doublons, Shortlist, Export : ils réutiliseront `DataGrid`, `Tabs` et
  `PageHeader`. Quand ils existeront, un onglet de navigation de challenge (« Idées · Notation ·
  Doublons · Shortlist · Export », composant `Tabs`) sera ajouté sous le `PageHeader`.
- Hypothèses à reporter dans le README : position d'affichage comme numéro de ligne ; vues non
  persistées ; tranches de budget fixes.
