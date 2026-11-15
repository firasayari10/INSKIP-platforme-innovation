/**
 * Conversion d'un budget saisi librement (« 40 000 € », « 15k€ », « 30 000 euros ») en euros.
 * La valeur d'origine est toujours conservée à côté : on ne perd jamais l'information.
 */

export type BudgetFlag = "budget_absent" | "budget_non_chiffre" | "budget_avec_commentaire" | "budget_ambigu";

export interface ParsedBudget {
  eur: number | null;
  flag: BudgetFlag | null;
}

const SPACES = /[\s  ]/g;
// Montant : milliers séparés par espace ou point, décimales après une virgule, puis unité éventuelle.
const AMOUNT =
  /^(\d{1,3}(?:[ .]\d{3})+|\d+)(?:,(\d{1,2}))?\s*(k|m|keur|meur|millions?|milliers?)?\s*(€|euros?|eur)?\s*(ht|ttc)?/i;

export function parseBudget(input: string): ParsedBudget {
  const raw = input.replace(SPACES, " ").trim();
  if (raw.length === 0) return { eur: null, flag: "budget_absent" };

  // Fourchette : « 10 à 20k », « 10-20 k€ ».
  if (/\d\s*(?:-|à|a|–)\s*\d/i.test(raw)) return { eur: null, flag: "budget_ambigu" };

  const match = AMOUNT.exec(raw);
  if (!match) return { eur: null, flag: "budget_non_chiffre" };

  const [whole, integerPart = "", decimals, unit] = match;
  let eur = Number(integerPart.replace(/[ .]/g, ""));
  if (decimals) eur += Number(`0.${decimals}`);

  const u = unit?.toLowerCase();
  if (u === "k" || u === "keur" || u?.startsWith("millier")) eur *= 1_000;
  else if (u === "m" || u === "meur" || u?.startsWith("million")) eur *= 1_000_000;

  if (!Number.isFinite(eur)) return { eur: null, flag: "budget_non_chiffre" };
  eur = Math.round(eur * 100) / 100;

  const rest = raw.slice(whole.length).trim();
  return { eur, flag: rest.length > 0 ? "budget_avec_commentaire" : null };
}
