import { ArrowDown, ArrowUp, ChevronDown, ListFilter } from "lucide-react";
import type { Ref } from "react";
import type { GridSort } from "@/domain/grid";
import { cn } from "@/lib/utils";

/**
 * Contenu d'un en-tête de colonne : libellé cliquable (tri) et bouton de filtre.
 * Les boutons sont hors de l'ordre de tabulation : au clavier, l'en-tête lui-même porte le focus
 * (Entrée/Espace = tri, Alt+↓ = filtre).
 */
export function ColumnHeader({
  label,
  rightAligned,
  sortable,
  sort,
  filterable,
  filtered,
  filterOpen,
  filterButtonRef,
  onSort,
  onOpenFilter,
}: {
  label: string;
  rightAligned: boolean;
  sortable: boolean;
  /** Sens du tri actif sur cette colonne, ou null. */
  sort: GridSort["direction"] | null;
  filterable: boolean;
  filtered: boolean;
  filterOpen: boolean;
  filterButtonRef: Ref<HTMLButtonElement>;
  onSort: () => void;
  onOpenFilter: () => void;
}) {
  const indicator =
    sort === "asc" ? (
      <ArrowUp className="size-3 shrink-0 text-primary" aria-hidden />
    ) : sort === "desc" ? (
      <ArrowDown className="size-3 shrink-0 text-primary" aria-hidden />
    ) : null;

  return (
    <div className="flex h-full items-center gap-1">
      {sortable ? (
        <button
          type="button"
          tabIndex={-1}
          title="Cliquer pour trier"
          onClick={onSort}
          className={cn(
            "flex h-full min-w-0 flex-1 items-center gap-1 text-left font-semibold",
            rightAligned && "justify-end",
          )}
        >
          <span className="truncate">{label}</span>
          {indicator}
        </button>
      ) : (
        <span className={cn("min-w-0 flex-1 truncate", rightAligned && "text-right")}>{label}</span>
      )}
      {filterable && (
        <button
          ref={filterButtonRef}
          type="button"
          tabIndex={-1}
          aria-label={`Filtrer la colonne ${label}`}
          aria-haspopup="dialog"
          aria-expanded={filterOpen}
          onClick={e => {
            e.stopPropagation();
            onOpenFilter();
          }}
          className={cn(
            "relative flex size-5 shrink-0 items-center justify-center rounded-sm border bg-background hover:bg-accent before:absolute before:-inset-0.5",
            filtered ? "border-primary" : "border-input",
          )}
        >
          {filtered ? (
            <ListFilter className="size-3 text-primary" aria-hidden />
          ) : (
            <ChevronDown className="size-3" aria-hidden />
          )}
        </button>
      )}
    </div>
  );
}
