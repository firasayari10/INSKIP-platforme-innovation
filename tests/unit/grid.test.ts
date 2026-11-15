import { describe, expect, test } from "bun:test";
import {
  applyGridQuery,
  BUDGET_RANGES,
  budgetRange,
  distinctValues,
  EMPTY_KEY,
  filterOptions,
  monthKey,
  monthLabel,
  sumKnown,
  type BudgetRange,
  type GridColumn,
  type GridQuery,
} from "@/domain/grid";

interface Row {
  ref: string;
  title: string;
  theme: string | null;
  budget: number | null;
}

const rows: Row[] = [
  { ref: "IDEA-010", title: "Rapprochement des factures", theme: "Digital", budget: null },
  { ref: "IDEA-002", title: "Tableau de bord fournisseurs", theme: "Process", budget: 15000 },
  { ref: "IDEA-001", title: "Capteurs de vibration", theme: "Énergie", budget: 40000 },
  { ref: "IDEA-015", title: "Café gratuit", theme: null, budget: null },
  { ref: "IDEA-009", title: "Fiches de poste en vidéo", theme: "Process", budget: 12000 },
];

const columns: GridColumn<Row>[] = [
  { key: "ref", value: r => r.ref, searchable: true },
  { key: "title", value: r => r.title, searchable: true },
  { key: "theme", value: r => r.theme, searchable: true },
  { key: "budget", value: r => r.budget },
];

const query = (over: Partial<GridQuery> = {}): GridQuery => ({ search: "", filters: {}, sort: null, ...over });
const refs = (rs: Row[]) => rs.map(r => r.ref);

describe("applyGridQuery : tri", () => {
  test("sans tri ni filtre, conserve l'ordre d'origine", () => {
    expect(refs(applyGridQuery(rows, columns, query()))).toEqual(refs(rows));
  });

  test("trie de A à Z en tenant compte des numéros (IDEA-2 avant IDEA-10)", () => {
    const r = applyGridQuery(rows, columns, query({ sort: { key: "ref", direction: "asc" } }));
    expect(refs(r)).toEqual(["IDEA-001", "IDEA-002", "IDEA-009", "IDEA-010", "IDEA-015"]);
  });

  test("trie les accents comme une personne (Énergie entre Digital et Process)", () => {
    const r = applyGridQuery(rows, columns, query({ sort: { key: "theme", direction: "asc" } }));
    expect(r.map(x => x.theme)).toEqual(["Digital", "Énergie", "Process", "Process", null]);
  });

  test("trie les montants du plus grand au plus petit, cellules vides toujours en dernier", () => {
    const r = applyGridQuery(rows, columns, query({ sort: { key: "budget", direction: "desc" } }));
    expect(r.map(x => x.budget)).toEqual([40000, 15000, 12000, null, null]);
  });

  test("le tri est stable : à valeur égale, l'ordre d'origine est conservé", () => {
    const r = applyGridQuery(rows, columns, query({ sort: { key: "theme", direction: "desc" } }));
    expect(refs(r).slice(0, 2)).toEqual(["IDEA-002", "IDEA-009"]);
  });
});

describe("applyGridQuery : filtres", () => {
  test("filtre une colonne sur les valeurs cochées", () => {
    const r = applyGridQuery(rows, columns, query({ filters: { theme: new Set(["Process"]) } }));
    expect(refs(r)).toEqual(["IDEA-002", "IDEA-009"]);
  });

  test("« (Vides) » sélectionne les cellules vides", () => {
    const r = applyGridQuery(rows, columns, query({ filters: { theme: new Set([EMPTY_KEY]) } }));
    expect(refs(r)).toEqual(["IDEA-015"]);
  });

  test("plusieurs colonnes filtrées se cumulent", () => {
    const r = applyGridQuery(
      rows,
      columns,
      query({ filters: { theme: new Set(["Process", EMPTY_KEY]), budget: new Set([EMPTY_KEY]) } }),
    );
    expect(refs(r)).toEqual(["IDEA-015"]);
  });

  test("aucune valeur cochée : aucune ligne", () => {
    expect(applyGridQuery(rows, columns, query({ filters: { theme: new Set() } }))).toEqual([]);
  });
});

describe("applyGridQuery : recherche", () => {
  test("cherche sans tenir compte des majuscules ni des accents", () => {
    expect(refs(applyGridQuery(rows, columns, query({ search: "CAFE" })))).toEqual(["IDEA-015"]);
    expect(refs(applyGridQuery(rows, columns, query({ search: "energie" })))).toEqual(["IDEA-001"]);
  });

  test("tous les mots doivent être présents, dans n'importe quelle colonne cherchable", () => {
    expect(refs(applyGridQuery(rows, columns, query({ search: "process tableau" })))).toEqual(["IDEA-002"]);
  });

  test("ne cherche pas dans les colonnes non cherchables", () => {
    expect(applyGridQuery(rows, columns, query({ search: "15000" }))).toEqual([]);
  });

  test("une recherche vide ou faite d'espaces ne filtre rien", () => {
    expect(applyGridQuery(rows, columns, query({ search: "   " }))).toHaveLength(rows.length);
  });
});

describe("distinctValues", () => {
  test("liste les valeurs d'une colonne avec leur nombre, triées, vides en dernier", () => {
    expect(distinctValues(rows, columns[2]!)).toEqual([
      { key: "Digital", label: "Digital", count: 1 },
      { key: "Énergie", label: "Énergie", count: 1 },
      { key: "Process", label: "Process", count: 2 },
      { key: EMPTY_KEY, label: "(Vides)", count: 1 },
    ]);
  });

  test("trie les nombres par valeur, pas par texte", () => {
    expect(distinctValues(rows, columns[3]!).map(v => v.key)).toEqual(["12000", "15000", "40000", EMPTY_KEY]);
  });
});

// ---------- Extensions : filtres multi-valeurs, tranches, mois, tri par défaut ----------

interface Idea {
  ref: string;
  budget: number | null;
  budgetRaw: string | null;
  date: string | null;
  flags: string[];
}

const ideas: Idea[] = [
  { ref: "IDEA-10", budget: 10000, budgetRaw: "10 000 €", date: "2026-03-12", flags: ["theme_manquant"] },
  { ref: "IDEA-2", budget: null, budgetRaw: "à définir", date: "2026-02-01", flags: ["budget_non_chiffre", "theme_manquant"] },
  { ref: "IDEA-1", budget: 120000, budgetRaw: "120k€", date: "2026-03-30", flags: [] },
  { ref: "IDEA-3", budget: null, budgetRaw: null, date: null, flags: ["date_manquante"] },
  { ref: "IDEA-4", budget: 9999, budgetRaw: "9 999 €", date: "2026-02-15", flags: [] },
];

const ideaColumns: GridColumn<Idea>[] = [
  { key: "ref", value: i => i.ref, searchable: true },
  {
    key: "budget",
    value: i => i.budget,
    filterValue: i => budgetRange(i.budget, i.budgetRaw),
    compareFilterKeys: (a, b) => BUDGET_RANGES.indexOf(a as BudgetRange) - BUDGET_RANGES.indexOf(b as BudgetRange),
  },
  {
    key: "date",
    value: i => i.date,
    filterValue: i => monthKey(i.date),
    filterLabel: monthLabel,
    compareFilterKeys: (a, b) => b.localeCompare(a),
  },
  {
    key: "flags",
    value: i => i.flags.length,
    filterValue: i => i.flags,
    emptyLabel: "(Aucun point d'attention)",
  },
];

describe("budgetRange", () => {
  test("classe un montant dans sa tranche, bornes incluses en bas", () => {
    expect(budgetRange(9999, "9 999 €")).toBe("moins_10k");
    expect(budgetRange(10000, "10 000 €")).toBe("10k_50k");
    expect(budgetRange(49999, null)).toBe("10k_50k");
    expect(budgetRange(50000, null)).toBe("50k_100k");
    expect(budgetRange(100000, null)).toBe("100k_plus");
  });

  test("un budget saisi sans montant est « non chiffré », pas vide", () => {
    expect(budgetRange(null, "à définir")).toBe("non_chiffre");
    expect(budgetRange(null, null)).toBeNull();
    expect(budgetRange(null, "   ")).toBeNull();
  });
});

describe("monthKey et monthLabel", () => {
  test("donne le mois d'une date ISO et son libellé en français", () => {
    expect(monthKey("2026-03-12")).toBe("2026-03");
    expect(monthKey("2026-11-15T10:22:33+00:00")).toBe("2026-11");
    expect(monthLabel("2026-03")).toBe("mars 2026");
    expect(monthLabel("2025-12")).toBe("décembre 2025");
  });

  test("une date absente ou illisible n'a pas de mois", () => {
    expect(monthKey(null)).toBeNull();
    expect(monthKey("12/03/2026")).toBeNull();
    expect(monthKey("2026-13-01")).toBeNull();
  });
});

describe("filtres par tranche, par mois et par points d'attention", () => {
  test("filtre le budget par tranche, « non chiffré » distinct de « (Vides) »", () => {
    const q = query({ filters: { budget: new Set(["non_chiffre"]) } });
    expect(applyGridQuery(ideas, ideaColumns, q).map(i => i.ref)).toEqual(["IDEA-2"]);
    const vides = query({ filters: { budget: new Set([EMPTY_KEY]) } });
    expect(applyGridQuery(ideas, ideaColumns, vides).map(i => i.ref)).toEqual(["IDEA-3"]);
  });

  test("filtre la date par mois", () => {
    const q = query({ filters: { date: new Set(["2026-02"]) } });
    expect(applyGridQuery(ideas, ideaColumns, q).map(i => i.ref)).toEqual(["IDEA-2", "IDEA-4"]);
  });

  test("une idée passe si elle porte au moins un des points cochés", () => {
    const q = query({ filters: { flags: new Set(["theme_manquant", "date_manquante"]) } });
    expect(applyGridQuery(ideas, ideaColumns, q).map(i => i.ref)).toEqual(["IDEA-10", "IDEA-2", "IDEA-3"]);
  });

  test("« (Aucun point d'attention) » retient les idées sans point", () => {
    const q = query({ filters: { flags: new Set([EMPTY_KEY]) } });
    expect(applyGridQuery(ideas, ideaColumns, q).map(i => i.ref)).toEqual(["IDEA-1", "IDEA-4"]);
  });

  test("les valeurs d'une même colonne se cumulent en OU, les colonnes en ET", () => {
    const q = query({
      filters: { budget: new Set(["moins_10k", "10k_50k"]), date: new Set(["2026-03"]) },
    });
    expect(applyGridQuery(ideas, ideaColumns, q).map(i => i.ref)).toEqual(["IDEA-10"]);
  });
});

describe("distinctValues : modes étendus", () => {
  test("liste les tranches dans l'ordre des montants, vides en dernier", () => {
    expect(distinctValues(ideas, ideaColumns[1]!).map(v => v.key)).toEqual([
      "moins_10k",
      "10k_50k",
      "100k_plus",
      "non_chiffre",
      EMPTY_KEY,
    ]);
  });

  test("liste les mois du plus récent au plus ancien avec leur libellé", () => {
    expect(distinctValues(ideas, ideaColumns[2]!)).toEqual([
      { key: "2026-03", label: "mars 2026", count: 2 },
      { key: "2026-02", label: "février 2026", count: 2 },
      { key: EMPTY_KEY, label: "(Vides)", count: 1 },
    ]);
  });

  test("compte chaque point d'attention une fois par idée, libellé propre pour les idées sans point", () => {
    expect(distinctValues(ideas, ideaColumns[3]!)).toEqual([
      { key: "budget_non_chiffre", label: "budget_non_chiffre", count: 1 },
      { key: "date_manquante", label: "date_manquante", count: 1 },
      { key: "theme_manquant", label: "theme_manquant", count: 2 },
      { key: EMPTY_KEY, label: "(Aucun point d'attention)", count: 2 },
    ]);
  });
});

describe("filterOptions", () => {
  test("propose les valeurs des lignes qui passent les autres filtres et la recherche", () => {
    const q = query({ filters: { date: new Set(["2026-02"]) } });
    expect(filterOptions(ideas, ideaColumns, q, "budget").map(v => v.key)).toEqual(["moins_10k", "non_chiffre"]);
  });

  test("ignore le filtre de la colonne elle-même et garde ses valeurs déjà cochées", () => {
    const q = query({ search: "IDEA-1", filters: { budget: new Set(["moins_10k"]) } });
    // La recherche « IDEA-1 » retient IDEA-10 et IDEA-1 ; « moins_10k » reste proposé, à 0.
    expect(filterOptions(ideas, ideaColumns, q, "budget")).toEqual([
      { key: "moins_10k", label: "moins_10k", count: 0 },
      { key: "10k_50k", label: "10k_50k", count: 1 },
      { key: "100k_plus", label: "100k_plus", count: 1 },
    ]);
  });
});

describe("applyGridQuery : tri par défaut et départage", () => {
  test("sans tri choisi, applique le tri par défaut", () => {
    const r = applyGridQuery(ideas, ideaColumns, { ...query(), defaultSort: { key: "ref", direction: "asc" } });
    expect(r.map(i => i.ref)).toEqual(["IDEA-1", "IDEA-2", "IDEA-3", "IDEA-4", "IDEA-10"]);
  });

  test("à valeur égale, départage par le tri par défaut (Réf. croissante)", () => {
    const r = applyGridQuery(ideas, ideaColumns, {
      ...query({ sort: { key: "flags", direction: "desc" } }),
      defaultSort: { key: "ref", direction: "asc" },
    });
    expect(r.map(i => i.ref)).toEqual(["IDEA-2", "IDEA-3", "IDEA-10", "IDEA-1", "IDEA-4"]);
  });
});

describe("sumKnown", () => {
  test("additionne les montants connus et compte les manquants", () => {
    expect(sumKnown([40000, null, 15000, null])).toEqual({ sum: 55000, missing: 2 });
    expect(sumKnown([])).toEqual({ sum: 0, missing: 0 });
  });
});
