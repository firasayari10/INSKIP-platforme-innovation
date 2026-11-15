import { describe, expect, test } from "bun:test";
import {
  activeFilterCount,
  EMPTY_FILTERS,
  filterIdeas,
  filtersFromParams,
  filtersToParams,
  NOT_SET,
  optionsFor,
  type FilterableIdea,
  type IdeaFilters,
} from "@/domain/ideaFilters";

const idea = (over: Partial<FilterableIdea> & { id: string }): FilterableIdea => ({
  external_ref: over.id.toUpperCase(),
  title: "Titre",
  description: "Description",
  direction: null,
  site: null,
  theme: null,
  quality_flags: [],
  ...over,
});

const ideas: FilterableIdea[] = [
  idea({ id: "a", title: "Capteurs de vibration", direction: "Maintenance", site: "Lyon", theme: "Énergie" }),
  idea({ id: "b", title: "Covoiturage entre salariés", direction: "IT", site: "Siège", theme: "Digital" }),
  idea({ id: "c", title: "Café gratuit", direction: "Production", site: "Grenoble", theme: null, quality_flags: ["theme_manquant"] }),
  idea({ id: "d", title: "Maintenance prédictive", description: "Prévoir les pannes des compresseurs", direction: "Maintenance", site: "Metz", theme: "Énergie" }),
  idea({ id: "e", title: "Programme ambassadeurs", direction: "Commercial", site: null, theme: "Client", quality_flags: ["site_manquant"] }),
];

const f = (over: Partial<IdeaFilters> = {}): IdeaFilters => ({ ...EMPTY_FILTERS, ...over });
const ids = (list: FilterableIdea[]) => list.map(i => i.id);
const noDuplicates = new Set<string>();

describe("filterIdeas", () => {
  test("sans filtre, toutes les idées restent, dans le même ordre", () => {
    expect(ids(filterIdeas(ideas, f(), noDuplicates))).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("filtre par direction", () => {
    expect(ids(filterIdeas(ideas, f({ direction: "Maintenance" }), noDuplicates))).toEqual(["a", "d"]);
  });

  test("filtre par thème, accents compris", () => {
    expect(ids(filterIdeas(ideas, f({ theme: "Énergie" }), noDuplicates))).toEqual(["a", "d"]);
  });

  test("« Non renseigné » retrouve les idées sans valeur", () => {
    expect(ids(filterIdeas(ideas, f({ theme: NOT_SET }), noDuplicates))).toEqual(["c"]);
    expect(ids(filterIdeas(ideas, f({ site: NOT_SET }), noDuplicates))).toEqual(["e"]);
  });

  test("plusieurs filtres se cumulent", () => {
    expect(ids(filterIdeas(ideas, f({ direction: "Maintenance", site: "Metz" }), noDuplicates))).toEqual(["d"]);
  });

  test("recherche sans tenir compte des majuscules ni des accents, dans le titre, la description et l'identifiant", () => {
    expect(ids(filterIdeas(ideas, f({ search: "CAFE" }), noDuplicates))).toEqual(["c"]);
    expect(ids(filterIdeas(ideas, f({ search: "compresseurs" }), noDuplicates))).toEqual(["d"]);
    expect(ids(filterIdeas(ideas, f({ search: "B" }), noDuplicates))).toContain("b");
  });

  test("la recherche exige tous les mots saisis", () => {
    expect(ids(filterIdeas(ideas, f({ search: "maintenance pannes" }), noDuplicates))).toEqual(["d"]);
  });

  test("points d'attention : avec ou sans", () => {
    expect(ids(filterIdeas(ideas, f({ attention: "with" }), noDuplicates))).toEqual(["c", "e"]);
    expect(ids(filterIdeas(ideas, f({ attention: "without" }), noDuplicates))).toEqual(["a", "b", "d"]);
  });

  test("doublons : idées concernées par une paire ou non", () => {
    const dup = new Set(["a", "d"]);
    expect(ids(filterIdeas(ideas, f({ duplicates: "with" }), dup))).toEqual(["a", "d"]);
    expect(ids(filterIdeas(ideas, f({ duplicates: "without" }), dup))).toEqual(["b", "c", "e"]);
  });

  test("une valeur qui n'existe plus ne renvoie aucune idée", () => {
    expect(filterIdeas(ideas, f({ direction: "Finance" }), noDuplicates)).toEqual([]);
  });
});

describe("optionsFor", () => {
  test("liste les valeurs distinctes triées avec leur nombre, « Non renseigné » en dernier", () => {
    expect(optionsFor(ideas, "site")).toEqual([
      { value: "Grenoble", label: "Grenoble", count: 1 },
      { value: "Lyon", label: "Lyon", count: 1 },
      { value: "Metz", label: "Metz", count: 1 },
      { value: "Siège", label: "Siège", count: 1 },
      { value: NOT_SET, label: "(Non renseigné)", count: 1 },
    ]);
  });

  test("trie les accents comme une personne", () => {
    expect(optionsFor(ideas, "theme").map(o => o.value)).toEqual(["Client", "Digital", "Énergie", NOT_SET]);
  });

  test("pas d'option « Non renseigné » si toutes les idées ont une valeur", () => {
    expect(optionsFor(ideas, "direction").some(o => o.value === NOT_SET)).toBe(false);
  });
});

describe("filtres dans l'adresse de la page", () => {
  test("aller-retour sans perte", () => {
    const filters = f({ search: "café", direction: "IT", theme: NOT_SET, attention: "with", duplicates: "without" });
    expect(filtersFromParams(filtersToParams(filters))).toEqual(filters);
  });

  test("seuls les filtres actifs apparaissent dans l'adresse", () => {
    expect(filtersToParams(f({ direction: "IT" })).toString()).toBe("direction=IT");
    expect(filtersToParams(f()).toString()).toBe("");
  });

  test("ignore les valeurs inconnues ou trafiquées", () => {
    const params = new URLSearchParams("attention=peut-etre&doublons=x&recherche=" + "a".repeat(500));
    const parsed = filtersFromParams(params);
    expect(parsed.attention).toBe("all");
    expect(parsed.duplicates).toBe("all");
    expect(parsed.search.length).toBe(200);
  });

  test("compte les filtres actifs", () => {
    expect(activeFilterCount(f())).toBe(0);
    expect(activeFilterCount(f({ search: "  " }))).toBe(0);
    expect(activeFilterCount(f({ search: "x", theme: "Digital", duplicates: "with" }))).toBe(3);
  });
});
