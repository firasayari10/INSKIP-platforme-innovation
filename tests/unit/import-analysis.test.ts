import { describe, expect, test } from "bun:test";
import { analyzeImport, LIMITS, type CsvTable } from "@/domain/importAnalysis";
import { checkFile, parseCsvText } from "@/lib/csv";

const HEADERS = ["id", "date_depot", "prenom", "nom", "direction", "site", "theme", "titre", "description", "benefices_attendus", "budget_estime"];
const DESC = "Une description suffisamment longue pour ne pas être signalée comme trop courte par l'analyse.";
const row = (over: Partial<Record<string, string>> = {}): string[] => {
  const base: Record<string, string> = {
    id: "IDEA-1", date_depot: "2026-09-15", prenom: "Ana", nom: "Durand", direction: "RH", site: "Lyon",
    theme: "Process", titre: "Une idée", description: DESC, benefices_attendus: "Gain", budget_estime: "10 000 €",
    ...over,
  };
  return HEADERS.map(h => base[h] ?? "");
};
const table = (rows: string[][], headers = HEADERS): CsvTable => ({ headers, rows });
const analyze = (t: CsvTable) => {
  const r = analyzeImport(t);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("analyzeImport : colonnes", () => {
  test("refuse un fichier sans colonne Titre ni Description et le dit précisément", () => {
    expect(analyzeImport(table([], ["id", "nom"]))).toEqual({
      ok: false,
      error: { code: "colonnes_manquantes", missing: ["title", "description"] },
    });
  });

  test("accepte des en-têtes avec majuscules, accents et espaces", () => {
    const headers = ["ID", "Date de dépôt", "Prénom", "Nom", "Direction", "Site", "Thème", "Titre", "Description", "Bénéfices attendus", "Budget estimé"];
    const r = analyze(table([row()], headers));
    expect(r.ideas).toHaveLength(1);
    expect(r.missingOptionalFields).toEqual([]);
  });

  test("signale les colonnes inconnues sans bloquer l'import", () => {
    const r = analyze(table([[...row(), "x"]], [...HEADERS, "Commentaire interne"]));
    expect(r.ignoredColumns).toEqual(["Commentaire interne"]);
    expect(r.ideas).toHaveLength(1);
  });

  test("refuse deux colonnes pour le même champ", () => {
    expect(analyzeImport(table([], [...HEADERS, "Titre"]))).toEqual({
      ok: false,
      error: { code: "colonnes_en_double", headers: ["Titre"] },
    });
  });

  test("refuse un fichier vide", () => {
    expect(analyzeImport(table([], [""]))).toEqual({ ok: false, error: { code: "fichier_vide" } });
  });

  test("refuse un fichier trop volumineux en nombre de lignes", () => {
    const rows = Array.from({ length: LIMITS.maxRows + 1 }, (_, i) => row({ id: `I-${i}` }));
    expect(analyzeImport(table(rows))).toMatchObject({ ok: false, error: { code: "trop_de_lignes" } });
  });
});

describe("analyzeImport : lignes", () => {
  test("ignore les lignes vides et les compte", () => {
    const r = analyze(table([row(), HEADERS.map(() => ""), HEADERS.map(() => "  "), row({ id: "IDEA-2" })]));
    expect(r.emptyLines).toEqual([3, 4]);
    expect(r.rowsRead).toBe(2);
    expect(r.ideas).toHaveLength(2);
  });

  test("rejette une ligne sans titre ni description, avec son numéro de ligne", () => {
    const r = analyze(table([row({ titre: "", description: " " })]));
    expect(r.ideas).toHaveLength(0);
    expect(r.rejected).toEqual([
      { line: 2, externalRef: "IDEA-1", title: null, errors: ["titre_manquant", "description_manquante"] },
    ]);
  });

  test("rejette un identifiant déjà utilisé plus haut dans le fichier", () => {
    const r = analyze(table([row(), row({ titre: "Autre idée" })]));
    expect(r.ideas).toHaveLength(1);
    expect(r.rejected[0]).toMatchObject({ line: 3, errors: ["identifiant_en_double"], firstLine: 2 });
  });

  test("rejette une ligne sans identifiant", () => {
    expect(analyze(table([row({ id: "" })])).rejected[0]?.errors).toEqual(["identifiant_manquant"]);
  });

  test("rejette un texte anormalement long", () => {
    expect(analyze(table([row({ titre: "x".repeat(LIMITS.title + 1) })])).rejected[0]?.errors).toEqual([
      "texte_trop_long",
    ]);
  });

  test("signale une description très courte", () => {
    expect(analyze(table([row({ description: "Café gratuit." })])).ideas[0]?.warnings).toContain("description_courte");
  });

  test("signale une cellule qui ressemble à une formule de tableur, sans l'interpréter", () => {
    const r = analyze(table([row({ titre: "=HYPERLINK(\"http://x\")" })]));
    expect(r.ideas[0]?.warnings).toContain("cellule_formule");
    expect(r.ideas[0]?.title).toBe("=HYPERLINK(\"http://x\")");
  });

  test("signale une idée sans auteur", () => {
    expect(analyze(table([row({ prenom: "", nom: "" })])).ideas[0]).toMatchObject({
      author: null,
      warnings: ["auteur_manquant"],
    });
  });

  test("nettoie les espaces superflus", () => {
    expect(analyze(table([row({ titre: "  Une   idée  " })])).ideas[0]?.title).toBe("Une idée");
  });
});

describe("lecture du fichier CSV", () => {
  test("accepte un séparateur virgule et des champs entre guillemets", () => {
    const r = parseCsvText('id,titre,description\r\nI-1,"Titre, avec virgule","Texte ""cité"""\r\n');
    expect(r).toEqual({ ok: true, value: { headers: ["id", "titre", "description"], rows: [["I-1", "Titre, avec virgule", 'Texte "cité"']] } });
  });

  test("refuse un fichier vide", () => {
    expect(parseCsvText("﻿  \r\n")).toEqual({ ok: false, error: "fichier_vide" });
  });

  test("contrôle l'extension et la taille avant lecture", () => {
    expect(checkFile({ name: "idees.xlsx", size: 10 })).toEqual({ ok: false, error: "format_non_supporte" });
    expect(checkFile({ name: "idees.csv", size: 6 * 1024 * 1024 })).toEqual({ ok: false, error: "fichier_trop_volumineux" });
    expect(checkFile({ name: "IDEES.CSV", size: 100 })).toEqual({ ok: true, value: true });
  });
});
