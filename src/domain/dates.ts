/** Dates de dépôt : ISO (AAAA-MM-JJ) ou format français (JJ/MM/AAAA, JJ-MM-AAAA, JJ.MM.AAAA). */

export type DateFlag = "date_manquante" | "date_invalide" | "date_reformatee";

export interface ParsedDate {
  iso: string | null;
  flag: DateFlag | null;
}

function toIso(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  const valid = d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  if (!valid || year < 1900 || year > 2100) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseSubmittedDate(input: string): ParsedDate {
  const raw = input.trim();
  if (raw.length === 0) return { iso: null, flag: "date_manquante" };

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) {
    const value = toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return value ? { iso: value, flag: null } : { iso: null, flag: "date_invalide" };
  }

  const fr = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(raw);
  if (fr) {
    const value = toIso(Number(fr[3]), Number(fr[2]), Number(fr[1]));
    return value ? { iso: value, flag: "date_reformatee" } : { iso: null, flag: "date_invalide" };
  }

  return { iso: null, flag: "date_invalide" };
}
