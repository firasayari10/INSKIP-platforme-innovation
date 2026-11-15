import type { ReactNode } from "react";
import { BUDGET_RANGES, monthKey, monthLabel, type BudgetRange, type GridColumn, type GridSort } from "@/domain/grid";
import { budgetRangeLabels } from "@/lib/messages";

export type ColumnKind = "ref" | "text" | "number" | "date" | "flags";
export type FilterMode = "values" | "budget-ranges" | "months" | "flags";

/** Contrat d'une colonne de grille (cf. docs/design/direction-ui.md §4.2). */
export interface DataGridColumn<R> extends GridColumn<R> {
  label: string;
  /** Largeur fixe en pixels. */
  width: number;
  /** Détermine l'alignement, les libellés de tri et la recherche par défaut. */
  kind: ColumnKind;
  /** Affichage ; par défaut la valeur mise en forme. */
  render?: (row: R) => ReactNode;
  /** Texte complet : zone de lecture, info-bulle, Ctrl+C. */
  text?: (row: R) => string;
  sortable?: boolean;
  filter?: FilterMode | false;
  /** Colonne gelée à gauche (après les numéros de ligne). */
  frozen?: boolean;
  /** Libellés d'avertissement de la cellule → marqueur de coin. */
  cellFlags?: (row: R) => string[];
}

/** Colonne de cases à cocher gelée avant les données (écran d'import). */
export interface CheckColumn<R> {
  label: string;
  /** Libellé de la case d'en-tête, qui agit sur les lignes affichées. */
  headerLabel: string;
  width: number;
  isChecked: (row: R) => boolean;
  onToggle: (row: R) => void;
  onToggleAll: (rows: readonly R[], checked: boolean) => void;
  ariaLabel: (row: R) => string;
}

export const isRightAligned = (kind: ColumnKind) => kind === "number" || kind === "date";

/** Premier sens de tri d'une colonne : les points d'attention commencent par les plus nombreux. */
export const firstDirection = (kind: ColumnKind): GridSort["direction"] => (kind === "flags" ? "desc" : "asc");

/** « de A à Z », « du plus grand au plus petit »… */
export function sortPhrase(kind: ColumnKind, direction: GridSort["direction"]): string {
  const asc = direction === "asc";
  switch (kind) {
    case "number":
    case "flags":
      return asc ? "du plus petit au plus grand" : "du plus grand au plus petit";
    case "date":
      return asc ? "du plus ancien au plus récent" : "du plus récent au plus ancien";
    default:
      return asc ? "de A à Z" : "de Z à A";
  }
}

const byLabel = (label: (k: string) => string) => (a: string, b: string) => label(a).localeCompare(label(b), "fr");

/** Complète une colonne avec les comportements par défaut de son type et de son mode de filtre. */
export function withDefaults<R>(column: DataGridColumn<R>): DataGridColumn<R> {
  const c: DataGridColumn<R> = {
    ...column,
    searchable: column.searchable ?? (column.kind === "text" || column.kind === "ref"),
  };
  switch (column.filter) {
    case "months":
      c.filterValue ??= row => {
        const v = column.value(row);
        return monthKey(typeof v === "string" ? v : null);
      };
      c.filterLabel ??= monthLabel;
      c.compareFilterKeys ??= (a, b) => b.localeCompare(a);
      break;
    case "budget-ranges":
      c.filterLabel ??= k => budgetRangeLabels[k as BudgetRange] ?? k;
      c.compareFilterKeys ??= (a, b) =>
        BUDGET_RANGES.indexOf(a as BudgetRange) - BUDGET_RANGES.indexOf(b as BudgetRange);
      break;
    case "flags":
      c.emptyLabel ??= "(Aucun point d'attention)";
      if (c.filterLabel) c.compareFilterKeys ??= byLabel(c.filterLabel);
      break;
  }
  return c;
}
