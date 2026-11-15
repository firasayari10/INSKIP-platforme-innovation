import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { analyzeImport, buildImportPayload, type ImportAnalysis } from "@/domain/importAnalysis";
import { parseCsvText } from "@/lib/csv";

/** Import de bout en bout sur l'export de référence (fictif) : BOM, `;`, CRLF, 40 idées. */
const text = await Bun.file(join(import.meta.dir, "../fixtures/idees_hexavia.csv")).text();

function analyze(): ImportAnalysis {
  const table = parseCsvText(text);
  if (!table.ok) throw new Error(`lecture : ${table.error}`);
  const result = analyzeImport(table.value);
  if (!result.ok) throw new Error(`analyse : ${JSON.stringify(result.error)}`);
  return result.value;
}

const analysis = analyze();
const byRef = (ref: string) => analysis.ideas.find(i => i.externalRef === `IDEA-${ref}`)!;
const hasPair = (a: string, b: string) =>
  analysis.duplicates.some(d => d.refA === `IDEA-${a}` && d.refB === `IDEA-${b}`);

describe("import de l'export de référence", () => {
  test("lit les 40 idées malgré le BOM, le séparateur ; et les fins de ligne CRLF", () => {
    expect(analysis.rowsRead).toBe(40);
    expect(analysis.ideas).toHaveLength(40);
    expect(analysis.rejected).toEqual([]);
    expect(analysis.ignoredColumns).toEqual([]);
    expect(byRef("001").title).toBe("Capteurs de vibration sur les compresseurs");
  });

  test("repère le doublon exact IDEA-002 / IDEA-014", () => {
    expect(analysis.duplicates).toContainEqual({ refA: "IDEA-002", refB: "IDEA-014", kind: "exact", similarity: 1 });
  });

  test("propose les reformulations les plus nettes", () => {
    expect(hasPair("003", "019")).toBe(true); // assistant RH / chatbot RH
    expect(hasPair("001", "007")).toBe(true); // capteurs / maintenance prédictive des compresseurs
  });

  test("ne propose pas d'idées sans rapport", () => {
    expect(hasPair("006", "021")).toBe(false);
    expect(hasPair("013", "025")).toBe(false);
  });

  test("normalise les budgets et garde la saisie d'origine", () => {
    expect(byRef("002")).toMatchObject({ budgetRaw: "15k€", budgetEur: 15000 });
    expect(byRef("003")).toMatchObject({ budgetRaw: "30 000 euros", budgetEur: 30000 });
    expect(byRef("010")).toMatchObject({ budgetRaw: "?", budgetEur: null });
    expect(byRef("010").warnings).toContain("budget_non_chiffre");
    expect(byRef("007").warnings).toContain("budget_absent");
    expect(byRef("023")).toMatchObject({ budgetEur: 80000 });
    expect(byRef("023").warnings).toContain("budget_avec_commentaire");
  });

  test("convertit la date au format français et le signale", () => {
    expect(byRef("033")).toMatchObject({ submittedAt: "2026-10-03", submittedAtRaw: "03/10/2026" });
    expect(byRef("033").warnings).toContain("date_reformatee");
  });

  test("signale les thèmes et sites manquants", () => {
    expect(byRef("015").warnings).toContain("theme_manquant");
    expect(byRef("029").warnings).toContain("theme_manquant");
    expect(byRef("040").warnings).toContain("site_manquant");
  });

  test("isole les données personnelles hors de la ligne source", () => {
    const idea = byRef("001");
    expect(idea.author).toEqual({ firstName: "Julie", lastName: "Marchand" });
    expect(Object.keys(idea.raw)).not.toContain("prenom");
    expect(Object.keys(idea.raw)).not.toContain("nom");
    expect(JSON.stringify(idea.raw)).not.toContain("Marchand");
  });

  test("le contenu envoyé à la base respecte les exclusions et ne contient aucune donnée personnelle dans le rapport", () => {
    const payload = buildImportPayload(analysis, new Set(["IDEA-014"]), key => `h:${key.length}`);
    expect(payload.ideas).toHaveLength(39);
    expect(payload.ideas.some(i => i.external_ref === "IDEA-014")).toBe(false);
    expect(payload.duplicates.some(d => d.ref_a === "IDEA-014" || d.ref_b === "IDEA-014")).toBe(false);
    expect(payload.report).toMatchObject({ rows_read: 40, rows_imported: 39, rows_excluded: 1, rows_rejected: 0 });
    expect(JSON.stringify(payload.report)).not.toMatch(/Marchand|Julie|Lefèvre/);
  });
});
