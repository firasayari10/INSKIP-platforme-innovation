/**
 * Pseudonymisation des textes envoyés au fournisseur d'IA (CLAUDE.md §7, RGPD) :
 * - protège les données personnelles (noms, coordonnées, identifiants) ;
 * - réduit les biais : l'IA juge l'idée, pas la personne (identité, civilité, âge).
 * Les personnes connues (auteurs du challenge) reçoivent un jeton STABLE ([PERSONNE_1]…) pour toute
 * la durée d'une évaluation, ce qui garde le texte cohérent et les clés de cache déterministes.
 * Pur : aucune dépendance, aucun réseau. Les correspondances ne quittent jamais le serveur.
 */

export interface PersonName {
  firstName: string | null;
  lastName: string | null;
}

export interface PseudonymizationReport {
  personnes: number;
  emails: number;
  telephones: number;
  identifiants: number;
}

export interface Pseudonymizer {
  text(input: string): string;
  maybe(input: string | null): string | null;
  report(): PseudonymizationReport;
}

/** Longueur minimale d'un nom remplacé seul (en dessous, trop de faux positifs). */
const MIN_NAME_LENGTH = 3;

const LETTER = "A-Za-zÀ-ÖØ-öø-ÿ";
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Motif tolérant aux accents et à la casse pour un mot : « Lefèvre » trouve « LEFEVRE ». */
function looseWord(word: string): string {
  return [...fold(word)]
    .map(ch => {
      const variants: Record<string, string> = {
        a: "aàâäáã", e: "eéèêë", i: "iîïíì", o: "oôöóò", u: "uùûüú", c: "cç", y: "yÿ", n: "nñ",
      };
      const v = variants[ch];
      return v ? `[${v}${v.toUpperCase()}]` : /[a-z]/.test(ch) ? `[${ch}${ch.toUpperCase()}]` : escape(ch);
    })
    .join("");
}

const bounded = (pattern: string) => new RegExp(`(?<![${LETTER}0-9])(?:${pattern})(?![${LETTER}0-9])`, "g");

// ---------- Coordonnées et identifiants ----------

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g;
const NIR = /\b[12]\s?\d{2}\s?(?:0[1-9]|1[0-2])\s?(?:\d{2}|2[AB])\s?\d{3}\s?\d{3}(?:\s?\d{2})?\b/g;
const PHONE = /(?<![\d])(?:\+33\s?|0033\s?|0)[1-9](?:[\s.-]?\d{2}){4}(?![\d])/g;
const STAFF_ID = /\b(matricule|badge|n°\s*employ[ée]|identifiant\s+salari[ée])(\s*(?:n°|no|num[ée]ro|:)?\s*)[A-Z0-9][A-Z0-9-]{2,}/gi;
const AGE = /\b(j['’]ai|âg[ée]e?s? de|à l['’]âge de)\s+\d{2}\s+ans\b/gi;
const CIVILITY = new RegExp(
  `\\b(?:M\\.|Mme|Mlle|Monsieur|Madame|Mademoiselle|Dr\\.?)\\s+[A-ZÀ-ÖØ-Þ][${LETTER}'’-]+(?:\\s+[A-ZÀ-ÖØ-Þ][${LETTER}'’-]+)?`,
  "g",
);

export function createPseudonymizer(people: readonly PersonName[]): Pseudonymizer {
  const counts: PseudonymizationReport = { personnes: 0, emails: 0, telephones: 0, identifiants: 0 };
  const tokens = new Map<number, string>(); // index de la personne → jeton, attribué à la 1re rencontre

  // Motifs par personne : « prénom nom », « nom prénom », puis « nom » seul. Les plus longs d'abord.
  const patterns: { person: number; re: RegExp }[] = [];
  people.forEach((p, index) => {
    const first = p.firstName?.trim() ?? "";
    const last = p.lastName?.trim() ?? "";
    if (last.length < MIN_NAME_LENGTH) return;
    if (first.length >= 2) {
      patterns.push({ person: index, re: bounded(`${looseWord(first)}\\s+${looseWord(last)}`) });
      patterns.push({ person: index, re: bounded(`${looseWord(last)}\\s+${looseWord(first)}`) });
    }
    patterns.push({ person: index, re: bounded(looseWord(last)) });
  });
  patterns.sort((a, b) => b.re.source.length - a.re.source.length);

  const tokenFor = (person: number) => {
    let t = tokens.get(person);
    if (!t) {
      t = `[PERSONNE_${tokens.size + 1}]`;
      tokens.set(person, t);
    }
    return t;
  };

  const replaceCounting = (text: string, re: RegExp, by: string | ((m: string, ...g: string[]) => string), key: keyof PseudonymizationReport) =>
    text.replace(re, (...args: string[]) => {
      counts[key] += 1;
      return typeof by === "string" ? by : by(args[0]!, ...args.slice(1));
    });

  const text = (input: string): string => {
    if (!input) return input;
    let out = input;
    out = replaceCounting(out, EMAIL, "[EMAIL]", "emails");
    out = replaceCounting(out, IBAN, "[IBAN]", "identifiants");
    out = replaceCounting(out, NIR, "[NUMERO_SECU]", "identifiants");
    out = replaceCounting(out, PHONE, "[TELEPHONE]", "telephones");
    out = replaceCounting(out, STAFF_ID, (_m, label: string) => (/badge/i.test(label) ? "badge [IDENTIFIANT]" : `${label} [IDENTIFIANT]`), "identifiants");
    out = out.replace(AGE, m => m.replace(/\d{2}\s+ans/, "[ÂGE]").replace(/^(j['’]ai|âg[ée]e?s? de|à l['’]âge de)\s+/i, s => s));
    for (const { person, re } of patterns) {
      out = replaceCounting(out, re, () => tokenFor(person), "personnes");
    }
    out = replaceCounting(out, CIVILITY, "[PERSONNE]", "personnes");
    return out;
  };

  return {
    text,
    maybe: input => (input === null ? null : text(input)),
    report: () => ({ ...counts }),
  };
}
