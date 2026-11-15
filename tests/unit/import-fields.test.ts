import { describe, expect, test } from "bun:test";
import { parseBudget } from "@/domain/budget";
import { parseSubmittedDate } from "@/domain/dates";

describe("parseBudget", () => {
  test.each([
    ["40 000 €", 40000],
    ["15k€", 15000],
    ["35k", 35000],
    ["30 000 euros", 30000],
    ["250 000 €", 250000],
    ["0", 0],
    ["0 €", 0],
    ["1,5 M€", 1500000],
    ["12 500,50 €", 12500.5],
    ["40 000 €", 40000],
    ["40.000 €", 40000],
  ])("convertit %p en %p euros sans signalement", (raw, eur) => {
    expect(parseBudget(raw)).toEqual({ eur, flag: null });
  });

  test("budget vide : absent", () => {
    expect(parseBudget("")).toEqual({ eur: null, flag: "budget_absent" });
    expect(parseBudget("   ")).toEqual({ eur: null, flag: "budget_absent" });
  });

  test.each(["?", "NC", "n/a", "inconnu", "à définir", "-"])("budget non chiffré : %p", raw => {
    expect(parseBudget(raw)).toEqual({ eur: null, flag: "budget_non_chiffre" });
  });

  test("garde le montant et signale le commentaire qui l'accompagne", () => {
    expect(parseBudget("80 000 € (déplacement des machines et formation)")).toEqual({
      eur: 80000,
      flag: "budget_avec_commentaire",
    });
  });

  test("une fourchette n'est pas convertie", () => {
    expect(parseBudget("10 à 20 k€")).toEqual({ eur: null, flag: "budget_ambigu" });
    expect(parseBudget("10-20k")).toEqual({ eur: null, flag: "budget_ambigu" });
  });
});

describe("parseSubmittedDate", () => {
  test("date ISO conservée", () => {
    expect(parseSubmittedDate("2026-09-15")).toEqual({ iso: "2026-09-15", flag: null });
  });

  test.each([
    ["03/10/2026", "2026-10-03"],
    ["3/10/2026", "2026-10-03"],
    ["03-10-2026", "2026-10-03"],
    ["03.10.2026", "2026-10-03"],
  ])("date française %p convertie en %p et signalée", (raw, iso) => {
    expect(parseSubmittedDate(raw)).toEqual({ iso, flag: "date_reformatee" });
  });

  test("date absente", () => {
    expect(parseSubmittedDate("")).toEqual({ iso: null, flag: "date_manquante" });
  });

  test.each(["2026-02-30", "31/04/2026", "demain", "2026/13/01", "15/09/26"])("date invalide : %p", raw => {
    expect(parseSubmittedDate(raw)).toEqual({ iso: null, flag: "date_invalide" });
  });
});
