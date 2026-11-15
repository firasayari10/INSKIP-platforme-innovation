import { Check, ListFilter, Search, X } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { Popover } from "@/components/Popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface FilterableColumn {
  key: string;
  label: string;
  active: boolean;
}

/** Barre d'outils : action de la page, puis recherche, menu « Filtrer », « Effacer les filtres ». */
export function GridToolbar({
  actions,
  search,
  onSearchChange,
  searchLabel,
  filterable,
  onPickFilter,
  onClear,
}: {
  actions?: ReactNode;
  search: string;
  onSearchChange: (value: string) => void;
  searchLabel: string;
  filterable: FilterableColumn[];
  onPickFilter: (key: string) => void;
  onClear: () => void;
}) {
  const id = useId();
  const filterButton = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const activeCount = filterable.filter(c => c.active).length;

  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background px-2 py-1">
      {actions && (
        <>
          {actions}
          <span className="h-5 w-px bg-border" aria-hidden />
        </>
      )}

      <div className="relative">
        <label htmlFor={`${id}-search`} className="sr-only">
          {searchLabel}
        </label>
        <Search
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          id={`${id}-search`}
          type="search"
          value={search}
          placeholder="Rechercher…"
          autoComplete="off"
          onChange={e => onSearchChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Escape" && search !== "") {
              e.preventDefault();
              onSearchChange("");
            }
          }}
          className="h-7 w-64 pr-7 pl-7 [&::-webkit-search-cancel-button]:hidden"
        />
        {search !== "" && (
          <button
            type="button"
            onClick={() => onSearchChange("")}
            aria-label="Effacer la recherche"
            className="absolute top-1/2 right-0.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        )}
      </div>

      {filterable.length > 0 && (
        <>
          <Button
            ref={filterButton}
            variant="outline"
            size="sm"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(o => !o)}
          >
            <ListFilter className="size-3.5" aria-hidden />
            {activeCount > 0 ? `Filtrer (${activeCount})` : "Filtrer"}
          </Button>
          <Popover
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            anchorRef={filterButton}
            align="start"
            label="Choisir une colonne à filtrer"
            className="w-56"
          >
            <ul>
              {filterable.map(c => (
                <li key={c.key}>
                  <button
                    type="button"
                    className="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left hover:bg-accent"
                    onClick={() => {
                      setMenuOpen(false);
                      onPickFilter(c.key);
                    }}
                  >
                    <span className="flex size-3.5 shrink-0 items-center">
                      {c.active && <Check className="size-3.5 text-primary" aria-hidden />}
                    </span>
                    {c.label}
                    {c.active && <span className="sr-only">(filtrée)</span>}
                  </button>
                </li>
              ))}
            </ul>
          </Popover>
          <Button variant="ghost" size="sm" onClick={onClear} disabled={activeCount === 0 && search.trim() === ""}>
            Effacer les filtres
          </Button>
        </>
      )}
    </div>
  );
}
