import { Search, X } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  activeFilterCount,
  EMPTY_FILTERS,
  optionsFor,
  type FacetField,
  type FilterableIdea,
  type IdeaFilters,
  type Presence,
} from "@/domain/ideaFilters";

/** Radix Select n'accepte pas de valeur vide : « Toutes » est représenté par cette clé. */
const ALL = "__toutes__";

export function IdeaFilterBar({
  ideas,
  filters,
  onChange,
  duplicatesAvailable,
}: {
  ideas: readonly FilterableIdea[];
  filters: IdeaFilters;
  onChange: (next: IdeaFilters) => void;
  duplicatesAvailable: boolean;
}) {
  const id = useId();
  const active = activeFilterCount(filters);
  const set = (patch: Partial<IdeaFilters>) => onChange({ ...filters, ...patch });

  const facet = (field: FacetField, label: string, allLabel: string) => {
    const options = optionsFor(ideas, field);
    const value = filters[field];
    // Valeur venue de l'adresse mais absente des idées : on l'affiche quand même pour pouvoir la retirer.
    const unknown = value !== null && !options.some(o => o.value === value);
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-${field}`} className="text-xs text-muted-foreground">
          {label}
        </Label>
        <Select value={value ?? ALL} onValueChange={v => set({ [field]: v === ALL ? null : v })}>
          <SelectTrigger id={`${id}-${field}`} className="h-9 w-full bg-background">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{allLabel}</SelectItem>
            {unknown && <SelectItem value={value}>{value} (0)</SelectItem>}
            {options.map(o => (
              <SelectItem key={o.value} value={o.value}>
                {o.label} ({o.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  };

  const presence = (
    field: "attention" | "duplicates",
    label: string,
    choices: Record<Presence, string>,
    disabled = false,
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-${field}`} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Select value={filters[field]} onValueChange={v => set({ [field]: v as Presence })} disabled={disabled}>
        <SelectTrigger id={`${id}-${field}`} className="h-9 w-full bg-background">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(choices) as Presence[]).map(k => (
            <SelectItem key={k} value={k}>
              {choices[k]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="space-y-3 rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1 space-y-1.5">
          <Label htmlFor={`${id}-search`} className="text-xs text-muted-foreground">
            Rechercher
          </Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id={`${id}-search`}
              type="search"
              value={filters.search}
              onChange={e => set({ search: e.target.value.slice(0, 200) })}
              placeholder="Titre, description ou identifiant"
              className="h-9 pl-9"
            />
          </div>
        </div>
        {active > 0 && (
          <Button variant="ghost" size="sm" className="h-9" onClick={() => onChange(EMPTY_FILTERS)}>
            <X className="size-4" aria-hidden />
            Effacer les filtres ({active})
          </Button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {facet("direction", "Direction", "Toutes les directions")}
        {facet("theme", "Thème", "Tous les thèmes")}
        {facet("site", "Site", "Tous les sites")}
        {presence("attention", "Points d'attention", {
          all: "Toutes les idées",
          with: "Avec un point d'attention",
          without: "Sans point d'attention",
        })}
        {presence(
          "duplicates",
          "Doublons",
          { all: "Toutes les idées", with: "Doublon possible", without: "Sans doublon" },
          !duplicatesAvailable,
        )}
      </div>
    </div>
  );
}
