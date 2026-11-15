/** Mise en forme française des montants, nombres et dates pour l'affichage. */

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("fr-FR");
const dateTime = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });

export const formatEuro = (amount: number): string => euro.format(amount);
export const formatNumber = (n: number): string => number.format(n);

/** « 12/03/2026 ». Une date seule (AAAA-MM-JJ) est lue telle quelle, sans décalage de fuseau. */
export function formatDate(iso: string | null): string {
  if (!iso) return "";
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (day) return `${day[3]}/${day[2]}/${day[1]}`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : dateTime.format(t);
}

/** « 1 idée », « 3 idées » (0 et 1 au singulier, comme en français). */
export function plural(n: number, one: string, many: string): string {
  return `${formatNumber(n)} ${n > 1 ? many : one}`;
}
