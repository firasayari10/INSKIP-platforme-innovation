import { normalizeText } from "./text";

/**
 * Filtres de la liste des idées : recherche, direction, thème, site, points d'attention, doublons.
 * Pur : reçoit les idées et renvoie celles qui correspondent, dans le même ordre.
 */

export interface FilterableIdea {
  id: string;
  external_ref: string;
  title: string;
  description: string;
  direction: string | null;
  site: string | null;
  theme: string | null;
  quality_flags: string[];
}

export type FacetField = "direction" | "theme" | "site";
export type Presence = "all" | "with" | "without";

export interface IdeaFilters {
  search: string;
  direction: string | null;
  theme: string | null;
  site: string | null;
  attention: Presence;
  duplicates: Presence;
}

/** Valeur de filtre désignant les idées sans valeur pour ce champ. */
export const NOT_SET = "__non_renseigne__";
const MAX_SEARCH = 200;

export const EMPTY_FILTERS: IdeaFilters = {
  search: "",
  direction: null,
  theme: null,
  site: null,
  attention: "all",
  duplicates: "all",
};

const blank = (v: string | null) => v === null || v.trim() === "";

function matchesFacet(value: string | null, selected: string | null): boolean {
  if (selected === null) return true;
  return selected === NOT_SET ? blank(value) : value === selected;
}

function matchesPresence(has: boolean, wanted: Presence): boolean {
  return wanted === "all" || (wanted === "with") === has;
}

export function filterIdeas<T extends FilterableIdea>(
  ideas: readonly T[],
  filters: IdeaFilters,
  duplicateIdeaIds: ReadonlySet<string>,
): T[] {
  const words = normalizeText(filters.search).split(" ").filter(Boolean);
  return ideas.filter(idea => {
    if (!matchesFacet(idea.direction, filters.direction)) return false;
    if (!matchesFacet(idea.theme, filters.theme)) return false;
    if (!matchesFacet(idea.site, filters.site)) return false;
    if (!matchesPresence(idea.quality_flags.length > 0, filters.attention)) return false;
    if (!matchesPresence(duplicateIdeaIds.has(idea.id), filters.duplicates)) return false;
    if (words.length > 0) {
      const text = normalizeText(`${idea.external_ref} ${idea.title} ${idea.description}`);
      if (!words.every(w => text.includes(w))) return false;
    }
    return true;
  });
}

export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

/** Valeurs proposées dans une liste déroulante, triées, « (Non renseigné) » en dernier. */
export function optionsFor(ideas: readonly FilterableIdea[], field: FacetField): FacetOption[] {
  const counts = new Map<string, number>();
  let empty = 0;
  for (const idea of ideas) {
    const v = idea[field];
    if (blank(v)) empty += 1;
    else counts.set(v!, (counts.get(v!) ?? 0) + 1);
  }
  const options = [...counts]
    .sort(([a], [b]) => collator.compare(a, b))
    .map(([value, count]) => ({ value, label: value, count }));
  if (empty > 0) options.push({ value: NOT_SET, label: "(Non renseigné)", count: empty });
  return options;
}

export function activeFilterCount(filters: IdeaFilters): number {
  return (
    (filters.search.trim() ? 1 : 0) +
    (filters.direction !== null ? 1 : 0) +
    (filters.theme !== null ? 1 : 0) +
    (filters.site !== null ? 1 : 0) +
    (filters.attention !== "all" ? 1 : 0) +
    (filters.duplicates !== "all" ? 1 : 0)
  );
}

// ---------- Adresse de la page (les filtres survivent à un rechargement) ----------

const PARAM = {
  search: "recherche",
  direction: "direction",
  theme: "theme",
  site: "site",
  attention: "attention",
  duplicates: "doublons",
} as const;

const PRESENCE_TO_PARAM: Record<Exclude<Presence, "all">, string> = { with: "avec", without: "sans" };
const presenceFrom = (raw: string | null): Presence =>
  raw === "avec" ? "with" : raw === "sans" ? "without" : "all";

/** Lit les filtres depuis l'adresse ; toute valeur inattendue est ignorée (entrée externe). */
export function filtersFromParams(params: URLSearchParams): IdeaFilters {
  const facet = (key: string) => {
    const v = params.get(key);
    return v && v.length <= 120 ? v : null;
  };
  return {
    search: (params.get(PARAM.search) ?? "").slice(0, MAX_SEARCH),
    direction: facet(PARAM.direction),
    theme: facet(PARAM.theme),
    site: facet(PARAM.site),
    attention: presenceFrom(params.get(PARAM.attention)),
    duplicates: presenceFrom(params.get(PARAM.duplicates)),
  };
}

export function filtersToParams(filters: IdeaFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search) params.set(PARAM.search, filters.search);
  if (filters.direction !== null) params.set(PARAM.direction, filters.direction);
  if (filters.theme !== null) params.set(PARAM.theme, filters.theme);
  if (filters.site !== null) params.set(PARAM.site, filters.site);
  if (filters.attention !== "all") params.set(PARAM.attention, PRESENCE_TO_PARAM[filters.attention]);
  if (filters.duplicates !== "all") params.set(PARAM.duplicates, PRESENCE_TO_PARAM[filters.duplicates]);
  return params;
}
