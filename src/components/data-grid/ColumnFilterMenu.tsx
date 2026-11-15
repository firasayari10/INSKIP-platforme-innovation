import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Popover } from "@/components/Popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DistinctValue, GridSort } from "@/domain/grid";
import { normalizeText } from "@/domain/text";
import { sortPhrase, type ColumnKind } from "./types";

const menuItem = "flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left hover:bg-accent disabled:opacity-50";

/**
 * Menu de filtre d'une colonne : tri, effacement, recherche de valeur, cases à cocher.
 * Le filtre ne s'applique qu'à « OK » ; Entrée = OK, Échap = Annuler.
 */
export function ColumnFilterMenu({
  open,
  label,
  kind,
  sortable,
  options,
  selected,
  anchorRef,
  onSort,
  onApply,
  onClose,
}: {
  open: boolean;
  label: string;
  kind: ColumnKind;
  sortable: boolean;
  /** Valeurs proposées (cf. `filterOptions`). */
  options: DistinctValue[];
  /** Valeurs retenues par le filtre actuel ; `undefined` = colonne non filtrée. */
  selected: ReadonlySet<string> | undefined;
  anchorRef: RefObject<HTMLElement | null>;
  onSort: (direction: GridSort["direction"]) => void;
  /** `null` : supprimer le filtre de la colonne. */
  onApply: (keys: ReadonlySet<string> | null) => void;
  onClose: () => void;
}) {
  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} align="end" label={`Filtre de la colonne ${label}`} className="w-66">
      <FilterBody
        label={label}
        kind={kind}
        sortable={sortable}
        options={options}
        selected={selected}
        onSort={onSort}
        onApply={onApply}
        onClose={onClose}
      />
    </Popover>
  );
}

function FilterBody({
  label,
  kind,
  sortable,
  options,
  selected,
  onSort,
  onApply,
  onClose,
}: {
  label: string;
  kind: ColumnKind;
  sortable: boolean;
  options: DistinctValue[];
  selected: ReadonlySet<string> | undefined;
  onSort: (direction: GridSort["direction"]) => void;
  onApply: (keys: ReadonlySet<string> | null) => void;
  onClose: () => void;
}) {
  const id = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const allRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Set<string>>(() => new Set(selected ?? options.map(o => o.key)));
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const words = normalizeText(query).split(" ").filter(Boolean);
    return options.filter(o => {
      const text = normalizeText(o.label);
      return words.every(w => text.includes(w));
    });
  }, [options, query]);

  const checkedVisible = visible.filter(o => draft.has(o.key)).length;
  const allChecked = visible.length > 0 && checkedVisible === visible.length;
  const someChecked = checkedVisible > 0 && !allChecked;

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = someChecked;
  }, [someChecked]);

  const toggle = (key: string) =>
    setDraft(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleVisible = () =>
    setDraft(prev => {
      const next = new Set(prev);
      for (const o of visible) {
        if (allChecked) next.delete(o.key);
        else next.add(o.key);
      }
      return next;
    });

  const apply = () => {
    if (draft.size === 0) return;
    // Tout coché = pas de filtre.
    const everything = options.every(o => draft.has(o.key));
    onApply(everything ? null : new Set(draft));
    onClose();
  };

  // ↑ ↓ parcourent le champ de recherche et les cases ; Entrée = OK (Échap est géré par le panneau).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (e.key === "Enter" && target instanceof HTMLInputElement) {
      e.preventDefault();
      apply();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const boxes = [...(listRef.current?.querySelectorAll<HTMLInputElement>("input[type=checkbox]") ?? [])];
    const search = document.getElementById(`${id}-search`);
    const stops: HTMLElement[] = search ? [search, ...boxes] : boxes;
    const index = stops.indexOf(target);
    if (index === -1) return;
    e.preventDefault();
    const next = stops[Math.max(0, Math.min(stops.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))];
    next?.focus();
  };

  return (
    <div onKeyDown={onKeyDown}>
      {sortable && (
        <>
          <button type="button" className={menuItem} onClick={() => {
              onSort("asc");
              onClose();
            }}>
            <ArrowUp className="size-3.5" aria-hidden />
            Trier {sortPhrase(kind, "asc")}
          </button>
          <button type="button" className={menuItem} onClick={() => {
              onSort("desc");
              onClose();
            }}>
            <ArrowDown className="size-3.5" aria-hidden />
            Trier {sortPhrase(kind, "desc")}
          </button>
          <div className="my-1 h-px bg-border" aria-hidden />
        </>
      )}
      <button
        type="button"
        className={menuItem}
        disabled={selected === undefined}
        onClick={() => {
          onApply(null);
          onClose();
        }}
      >
        <span className="size-3.5" aria-hidden />
        Effacer le filtre de « {label} »
      </button>
      <div className="my-1 h-px bg-border" aria-hidden />

      <div className="space-y-1 px-1 pt-1">
        <label htmlFor={`${id}-search`} className="sr-only">
          Rechercher une valeur
        </label>
        <Input
          id={`${id}-search`}
          className="h-7"
          placeholder="Rechercher une valeur"
          autoComplete="off"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <ul ref={listRef} className="max-h-60 overflow-auto rounded-sm border border-border py-1" aria-label={`Valeurs de la colonne ${label}`}>
          {visible.length > 0 && (
            <li>
              <label className="flex h-6 items-center gap-2 px-2 hover:bg-accent">
                <input
                  ref={allRef}
                  type="checkbox"
                  className="size-3.5"
                  checked={allChecked}
                  onChange={toggleVisible}
                />
                (Tout sélectionner)
              </label>
            </li>
          )}
          {visible.map(o => (
            <li key={o.key}>
              <label className="flex h-6 items-center gap-2 px-2 hover:bg-accent">
                <input type="checkbox" className="size-3.5 shrink-0" checked={draft.has(o.key)} onChange={() => toggle(o.key)} />
                <span className="min-w-0 truncate" title={o.label}>
                  {o.label}
                </span>
                <span className="shrink-0 text-muted-foreground tabular-nums">({o.count})</span>
              </label>
            </li>
          ))}
          {visible.length === 0 && <li className="px-2 py-1 text-muted-foreground">Aucune valeur ne correspond.</li>}
        </ul>
      </div>

      <div className="flex justify-end gap-2 px-1 pt-2 pb-1">
        <Button size="sm" onClick={apply} disabled={draft.size === 0}>
          OK
        </Button>
        <Button size="sm" variant="outline" onClick={onClose}>
          Annuler
        </Button>
      </div>
    </div>
  );
}
