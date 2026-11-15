import { TriangleAlert } from "lucide-react";
import type { DataGridColumn } from "@/components/data-grid/types";
import { budgetRange, type GridSort } from "@/domain/grid";
import type { AnalyzedIdea } from "@/domain/importAnalysis";
import type { IdeaRow } from "@/lib/data";
import { formatDate, formatEuro } from "@/lib/format";
import { warningLabel } from "@/lib/messages";

/** Ligne commune au tableau des idées enregistrées et à l'aperçu d'import. */
export interface IdeaGridRow {
  ref: string;
  title: string;
  direction: string | null;
  site: string | null;
  theme: string | null;
  budgetEur: number | null;
  budgetRaw: string | null;
  submittedAt: string | null;
  /** Codes des points d'attention. */
  flags: string[];
}

export const fromIdeaRow = (i: IdeaRow): IdeaGridRow => ({
  ref: i.external_ref,
  title: i.title,
  direction: i.direction,
  site: i.site,
  theme: i.theme,
  budgetEur: i.budget_eur,
  budgetRaw: i.budget_raw,
  submittedAt: i.submitted_at,
  flags: i.quality_flags,
});

export const fromAnalyzedIdea = (i: AnalyzedIdea): IdeaGridRow => ({
  ref: i.externalRef,
  title: i.title,
  direction: i.direction,
  site: i.site,
  theme: i.theme,
  budgetEur: i.budgetEur,
  budgetRaw: i.budgetRaw,
  submittedAt: i.submittedAt,
  flags: i.warnings,
});

/**
 * Colonne marquée par chaque point d'attention. `auteur_manquant` et `cellule_formule` n'ont pas
 * de colonne : ils n'apparaissent que dans « Points d'attention ».
 */
const FLAG_COLUMN: Record<string, keyof IdeaGridRow> = {
  description_courte: "title",
  direction_manquante: "direction",
  site_manquant: "site",
  theme_manquant: "theme",
  budget_absent: "budgetEur",
  budget_non_chiffre: "budgetEur",
  budget_avec_commentaire: "budgetEur",
  budget_ambigu: "budgetEur",
  date_manquante: "submittedAt",
  date_invalide: "submittedAt",
  date_reformatee: "submittedAt",
};

const flagsFor = (field: keyof IdeaGridRow) => (row: IdeaGridRow) =>
  row.flags.filter(f => FLAG_COLUMN[f] === field).map(warningLabel);

export const ideaDefaultSort: GridSort = { key: "ref", direction: "asc" };

/** Colonnes du tableau des idées (docs/design/direction-ui.md §4.12). */
export const ideaColumns: DataGridColumn<IdeaGridRow>[] = [
  { key: "ref", label: "Réf.", width: 96, kind: "ref", frozen: true, value: r => r.ref },
  { key: "title", label: "Titre", width: 360, kind: "text", value: r => r.title, cellFlags: flagsFor("title") },
  {
    key: "direction",
    label: "Direction",
    width: 160,
    kind: "text",
    filter: "values",
    value: r => r.direction,
    cellFlags: flagsFor("direction"),
  },
  { key: "site", label: "Site", width: 140, kind: "text", filter: "values", value: r => r.site, cellFlags: flagsFor("site") },
  {
    key: "theme",
    label: "Thème",
    width: 160,
    kind: "text",
    filter: "values",
    value: r => r.theme,
    cellFlags: flagsFor("theme"),
  },
  {
    key: "budget",
    label: "Budget",
    width: 112,
    kind: "number",
    filter: "budget-ranges",
    value: r => r.budgetEur,
    filterValue: r => budgetRange(r.budgetEur, r.budgetRaw),
    text: r => (r.budgetEur !== null ? formatEuro(r.budgetEur) : (r.budgetRaw ?? "")),
    render: r =>
      r.budgetEur !== null ? (
        formatEuro(r.budgetEur)
      ) : r.budgetRaw ? (
        <span className="text-muted-foreground">{r.budgetRaw}</span>
      ) : (
        <span className="sr-only">Vide</span>
      ),
    cellFlags: r => {
      const flags = flagsFor("budgetEur")(r);
      // Montant illisible : toujours signalé, même sans code enregistré.
      return r.budgetEur === null && r.budgetRaw && flags.length === 0 ? [warningLabel("budget_non_chiffre")] : flags;
    },
  },
  {
    key: "submittedAt",
    label: "Date de dépôt",
    width: 112,
    kind: "date",
    filter: "months",
    value: r => r.submittedAt,
    text: r => formatDate(r.submittedAt),
    cellFlags: flagsFor("submittedAt"),
  },
  {
    key: "flags",
    label: "Points d'attention",
    width: 240,
    kind: "flags",
    filter: "flags",
    value: r => r.flags.length,
    filterValue: r => r.flags,
    filterLabel: warningLabel,
    text: r => r.flags.map(warningLabel).join(" ; "),
    render: r => {
      const [first] = r.flags;
      if (!first) return <span className="sr-only">Aucun</span>;
      return (
        <span className="flex min-w-0 items-center gap-1 text-warning">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {warningLabel(first)}
            {r.flags.length > 1 && ` (+${r.flags.length - 1})`}
          </span>
        </span>
      );
    },
  },
];
