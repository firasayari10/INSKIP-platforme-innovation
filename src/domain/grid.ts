import { normalizeText } from "./text";

/**
 * Logique d'une grille de données façon tableur : tri par colonne, filtre automatique par
 * valeurs cochées (avec « (Vides) »), recherche plein texte. Pur et générique.
 */

export type CellValue = string | number | null;

/** Valeur vue par le filtre : une valeur, ou plusieurs (la ligne passe si l'une est cochée). */
export type FilterCellValue = CellValue | readonly string[];

export interface GridColumn<R> {
  key: string;
  /** Valeur triée et cherchée (et filtrée, sauf si `filterValue` est fourni). */
  value: (row: R) => CellValue;
  /** La recherche plein texte porte sur cette colonne. */
  searchable?: boolean;
  /** Valeur(s) utilisée(s) par le filtre et le menu de filtre ; par défaut `value`. */
  filterValue?: (row: R) => FilterCellValue;
  /** Libellé d'une clé de filtre dans le menu ; par défaut la valeur elle-même. */
  filterLabel?: (key: string) => string;
  /** Ordre des clés dans le menu de filtre ; par défaut croissant (texte ou nombre). */
  compareFilterKeys?: (a: string, b: string) => number;
  /** Libellé de la case des cellules vides ; par défaut « (Vides) ». */
  emptyLabel?: string;
}

export interface GridSort {
  key: string;
  direction: "asc" | "desc";
}

export interface GridQuery {
  search: string;
  /** Pour chaque colonne filtrée : clés des valeurs cochées. Colonne absente = pas de filtre. */
  filters: Record<string, ReadonlySet<string>>;
  sort: GridSort | null;
  /** Tri appliqué quand aucun tri n'est choisi, et départage des égalités sinon. */
  defaultSort?: GridSort | null;
}

/** Clé des cellules vides dans un filtre (affichée « (Vides) »). */
export const EMPTY_KEY = "\u0000vide";

const isEmpty = (v: CellValue): v is null | "" => v === null || (typeof v === "string" && v.trim() === "");

export function filterKey(v: CellValue): string {
  return isEmpty(v) ? EMPTY_KEY : String(v);
}

/** Clés de filtre d'une ligne pour une colonne (plusieurs si la colonne porte plusieurs valeurs). */
function filterKeysOf<R>(column: GridColumn<R>, row: R): string[] {
  const v = column.filterValue ? column.filterValue(row) : column.value(row);
  if (Array.isArray(v)) {
    const keys = [...new Set(v.filter(x => !isEmpty(x)))];
    return keys.length > 0 ? keys : [EMPTY_KEY];
  }
  return [filterKey(v as CellValue)];
}

const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

function compareValues(a: CellValue, b: CellValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

/** Compare deux valeurs pour un tri : vides toujours en dernier, quel que soit le sens. */
function compareForSort(a: CellValue, b: CellValue, direction: GridSort["direction"]): number {
  const ea = isEmpty(a);
  const eb = isEmpty(b);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  return (direction === "asc" ? 1 : -1) * compareValues(a, b);
}

/** Lignes qui passent la recherche et les filtres, en ignorant éventuellement le filtre d'une colonne. */
function filterRows<R>(
  rows: readonly R[],
  columns: readonly GridColumn<R>[],
  query: Pick<GridQuery, "search" | "filters">,
  ignoredKey?: string,
): R[] {
  const byKey = new Map(columns.map(c => [c.key, c]));
  const words = normalizeText(query.search).split(" ").filter(Boolean);
  const searchable = columns.filter(c => c.searchable);
  const activeFilters = Object.entries(query.filters).flatMap(([key, allowed]) => {
    const column = key === ignoredKey ? undefined : byKey.get(key);
    return column ? [{ column, allowed }] : [];
  });

  return rows.filter(row => {
    for (const { column, allowed } of activeFilters) {
      if (!filterKeysOf(column, row).some(k => allowed.has(k))) return false;
    }
    if (words.length > 0) {
      const haystack = normalizeText(searchable.map(c => c.value(row) ?? "").join(" "));
      if (!words.every(w => haystack.includes(w))) return false;
    }
    return true;
  });
}

export function applyGridQuery<R>(rows: readonly R[], columns: readonly GridColumn<R>[], query: GridQuery): R[] {
  const byKey = new Map(columns.map(c => [c.key, c]));
  const kept = filterRows(rows, columns, query);

  const sorts = [query.sort, query.defaultSort ?? null].flatMap(s => {
    const column = s ? byKey.get(s.key) : undefined;
    return s && column ? [{ column, direction: s.direction }] : [];
  });
  if (sorts.length === 0) return kept;

  // Tri stable ; comme dans un tableur, les cellules vides restent en bas dans les deux sens.
  return kept
    .map((row, index) => ({ row, index, values: sorts.map(s => s.column.value(row)) }))
    .sort((x, y) => {
      for (let i = 0; i < sorts.length; i++) {
        const c = compareForSort(x.values[i] ?? null, y.values[i] ?? null, sorts[i]!.direction);
        if (c !== 0) return c;
      }
      return x.index - y.index;
    })
    .map(x => x.row);
}

export interface DistinctValue {
  key: string;
  label: string;
  count: number;
}

function toDistinct<R>(column: GridColumn<R>, counts: Map<string, number>): DistinctValue[] {
  const compare = column.compareFilterKeys ?? ((a: string, b: string) => compareValues(a, b));
  return [...counts]
    .sort(([ka], [kb]) => {
      if (ka === EMPTY_KEY || kb === EMPTY_KEY) return ka === kb ? 0 : ka === EMPTY_KEY ? 1 : -1;
      return compare(ka, kb);
    })
    .map(([key, count]) => ({
      key,
      label: key === EMPTY_KEY ? (column.emptyLabel ?? "(Vides)") : (column.filterLabel?.(key) ?? key),
      count,
    }));
}

function countKeys<R>(rows: readonly R[], column: GridColumn<R>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const key of filterKeysOf(column, row)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Valeurs distinctes d'une colonne pour le menu de filtre, triées, « (Vides) » en dernier. */
export function distinctValues<R>(rows: readonly R[], column: GridColumn<R>): DistinctValue[] {
  // Les nombres sont comparés numériquement même convertis en clés texte (collation numérique).
  return toDistinct(column, countKeys(rows, column));
}

/**
 * Valeurs proposées dans le menu de filtre d'une colonne (comportement du filtre automatique) :
 * celles des lignes qui passent la recherche et les filtres des AUTRES colonnes, plus les valeurs
 * déjà cochées pour cette colonne (avec un compte de 0 si plus aucune ligne ne les porte).
 */
export function filterOptions<R>(
  rows: readonly R[],
  columns: readonly GridColumn<R>[],
  query: Pick<GridQuery, "search" | "filters">,
  columnKey: string,
): DistinctValue[] {
  const column = columns.find(c => c.key === columnKey);
  if (!column) return [];
  const counts = countKeys(filterRows(rows, columns, query, columnKey), column);
  for (const key of query.filters[columnKey] ?? []) if (!counts.has(key)) counts.set(key, 0);
  return toDistinct(column, counts);
}

// ---------- Tranches de budget ----------

/** Tranches fixes du filtre de budget, dans l'ordre d'affichage. */
export const BUDGET_RANGES = ["moins_10k", "10k_50k", "50k_100k", "100k_plus", "non_chiffre"] as const;
export type BudgetRange = (typeof BUDGET_RANGES)[number];

/**
 * Tranche d'un budget. Borne basse incluse (10 000 € → « 10k_50k »). Un budget saisi sans
 * montant lisible est « non chiffré » ; sans saisie du tout, il est vide (null).
 */
export function budgetRange(amount: number | null, raw: string | null): BudgetRange | null {
  if (amount === null) return raw !== null && raw.trim() !== "" ? "non_chiffre" : null;
  if (amount < 10_000) return "moins_10k";
  if (amount < 50_000) return "10k_50k";
  if (amount < 100_000) return "50k_100k";
  return "100k_plus";
}

// ---------- Mois ----------

const MONTHS = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];

/** Mois (« AAAA-MM ») d'une date ISO, ou null si absente ou illisible. */
export function monthKey(iso: string | null): string | null {
  const m = iso ? /^(\d{4})-(\d{2})/.exec(iso) : null;
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? `${m[1]}-${m[2]}` : null;
}

/** Libellé français d'un mois « AAAA-MM » : « mars 2026 ». */
export function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  const name = MONTHS[Number(month) - 1];
  return name && year ? `${name} ${year}` : key;
}

// ---------- Agrégats ----------

/** Somme des montants connus et nombre de montants manquants. */
export function sumKnown(values: readonly (number | null)[]): { sum: number; missing: number } {
  let sum = 0;
  let missing = 0;
  for (const v of values) {
    if (v === null) missing += 1;
    else sum += v;
  }
  return { sum, missing };
}
