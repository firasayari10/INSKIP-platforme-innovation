import { parseBudget, type BudgetFlag } from "./budget";
import { parseSubmittedDate, type DateFlag } from "./dates";
import { err, ok, type Result } from "./result";
import { findDuplicateCandidates, type DuplicateCandidate } from "./similarity";
import { contentKey, normalizeText } from "./text";

/**
 * Analyse d'un export d'idées avant enregistrement : colonnes, lignes vides, champs manquants,
 * normalisation (dates, budgets), doublons. Pur : reçoit un tableau de cellules déjà lu.
 */

// ---------- Colonnes ----------

export type FieldKey =
  | "external_ref"
  | "submitted_at"
  | "first_name"
  | "last_name"
  | "direction"
  | "site"
  | "theme"
  | "title"
  | "description"
  | "expected_benefits"
  | "budget";

/** En-têtes acceptés pour chaque champ, après normalisation (minuscules, sans accents, `_` → espace). */
const HEADER_ALIASES: Record<FieldKey, string[]> = {
  external_ref: ["id", "identifiant", "ref", "reference", "id idee"],
  submitted_at: ["date depot", "date de depot", "date", "date soumission"],
  first_name: ["prenom"],
  last_name: ["nom", "nom famille"],
  direction: ["direction", "service", "departement"],
  site: ["site", "lieu", "etablissement"],
  theme: ["theme", "thematique", "categorie"],
  title: ["titre", "titre idee", "intitule"],
  description: ["description", "description idee", "idee"],
  expected_benefits: ["benefices attendus", "benefices", "gains attendus", "gains"],
  budget: ["budget estime", "budget"],
};

export const REQUIRED_FIELDS: FieldKey[] = ["external_ref", "title", "description"];
const PERSONAL_FIELDS: FieldKey[] = ["first_name", "last_name"];

const normalizeHeader = (h: string) => normalizeText(h.replace(/_/g, " "));

// ---------- Limites ----------

export const LIMITS = {
  maxRows: 2000,
  ref: 64,
  title: 300,
  description: 10_000,
  benefits: 5_000,
  shortField: 120,
  budget: 200,
  name: 100,
  shortDescription: 60,
} as const;

// ---------- Résultats ----------

export type RowErrorCode =
  | "identifiant_manquant"
  | "identifiant_en_double"
  | "titre_manquant"
  | "description_manquante"
  | "texte_trop_long";

export type RowWarningCode =
  | "theme_manquant"
  | "site_manquant"
  | "direction_manquante"
  | "auteur_manquant"
  | "description_courte"
  | "cellule_formule"
  | BudgetFlag
  | DateFlag;

export interface AnalyzedIdea {
  line: number; // numéro de ligne dans le fichier (en-tête = 1)
  externalRef: string;
  title: string;
  description: string;
  expectedBenefits: string | null;
  direction: string | null;
  site: string | null;
  theme: string | null;
  budgetRaw: string | null;
  budgetEur: number | null;
  submittedAt: string | null;
  submittedAtRaw: string | null;
  author: { firstName: string | null; lastName: string | null } | null;
  /** Ligne source sans données personnelles, indexée par l'en-tête d'origine. */
  raw: Record<string, string>;
  warnings: RowWarningCode[];
}

export interface RejectedRow {
  line: number;
  externalRef: string | null;
  title: string | null;
  errors: RowErrorCode[];
  /** Pour « identifiant_en_double » : ligne où l'identifiant apparaît en premier. */
  firstLine?: number;
}

export interface ImportAnalysis {
  rowsRead: number;
  emptyLines: number[];
  ideas: AnalyzedIdea[];
  rejected: RejectedRow[];
  duplicates: DuplicateCandidate[];
  ignoredColumns: string[];
  missingOptionalFields: FieldKey[];
}

export type FileError =
  | { code: "fichier_vide" }
  | { code: "colonnes_manquantes"; missing: FieldKey[] }
  | { code: "colonnes_en_double"; headers: string[] }
  | { code: "trop_de_lignes"; max: number; found: number };

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

// ---------- Analyse ----------

export function analyzeImport(table: CsvTable): Result<ImportAnalysis, FileError> {
  const headers = table.headers.map(h => h.trim());
  if (headers.every(h => h === "")) return err({ code: "fichier_vide" });

  // Correspondance colonne → champ.
  const columnOf = new Map<FieldKey, number>();
  const ignoredColumns: string[] = [];
  const duplicatedHeaders: string[] = [];
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    const field = (Object.keys(HEADER_ALIASES) as FieldKey[]).find(k => HEADER_ALIASES[k].includes(normalized));
    if (!field) {
      if (header !== "") ignoredColumns.push(header);
      return;
    }
    if (columnOf.has(field)) duplicatedHeaders.push(header);
    else columnOf.set(field, index);
  });

  if (duplicatedHeaders.length > 0) return err({ code: "colonnes_en_double", headers: duplicatedHeaders });
  const missing = REQUIRED_FIELDS.filter(f => !columnOf.has(f));
  if (missing.length > 0) return err({ code: "colonnes_manquantes", missing });

  const dataRows = table.rows;
  if (dataRows.length > LIMITS.maxRows) {
    return err({ code: "trop_de_lignes", max: LIMITS.maxRows, found: dataRows.length });
  }

  const missingOptionalFields = (Object.keys(HEADER_ALIASES) as FieldKey[]).filter(
    f => !columnOf.has(f) && !REQUIRED_FIELDS.includes(f),
  );

  const cell = (row: string[], field: FieldKey): string => {
    const index = columnOf.get(field);
    return index === undefined ? "" : (row[index] ?? "").replace(/\s+/g, " ").trim();
  };
  const personalColumns = new Set(PERSONAL_FIELDS.map(f => columnOf.get(f)).filter(i => i !== undefined));

  const ideas: AnalyzedIdea[] = [];
  const rejected: RejectedRow[] = [];
  const emptyLines: number[] = [];
  const firstLineOfRef = new Map<string, number>();

  dataRows.forEach((row, index) => {
    const line = index + 2;
    if (row.every(c => (c ?? "").trim() === "")) {
      emptyLines.push(line);
      return;
    }

    const externalRef = cell(row, "external_ref");
    const title = cell(row, "title");
    const description = cell(row, "description");
    const benefits = cell(row, "expected_benefits");
    const direction = cell(row, "direction");
    const site = cell(row, "site");
    const theme = cell(row, "theme");
    const budgetRaw = cell(row, "budget");
    const dateRaw = cell(row, "submitted_at");
    const firstName = cell(row, "first_name");
    const lastName = cell(row, "last_name");

    // Erreurs bloquantes : la ligne n'est pas importée.
    const errors: RowErrorCode[] = [];
    if (!externalRef) errors.push("identifiant_manquant");
    if (!title) errors.push("titre_manquant");
    if (!description) errors.push("description_manquante");
    const tooLong =
      externalRef.length > LIMITS.ref ||
      title.length > LIMITS.title ||
      description.length > LIMITS.description ||
      benefits.length > LIMITS.benefits ||
      [direction, site, theme].some(v => v.length > LIMITS.shortField) ||
      budgetRaw.length > LIMITS.budget ||
      firstName.length > LIMITS.name ||
      lastName.length > LIMITS.name;
    if (tooLong) errors.push("texte_trop_long");

    const firstLine = externalRef ? firstLineOfRef.get(externalRef) : undefined;
    if (firstLine !== undefined) errors.push("identifiant_en_double");

    if (errors.length > 0) {
      rejected.push({
        line,
        externalRef: externalRef || null,
        title: title || null,
        errors,
        ...(firstLine !== undefined ? { firstLine } : {}),
      });
      return;
    }
    firstLineOfRef.set(externalRef, line);

    // Avertissements : la ligne est importée, le point est signalé.
    const warnings: RowWarningCode[] = [];
    if (columnOf.has("theme") && !theme) warnings.push("theme_manquant");
    if (columnOf.has("site") && !site) warnings.push("site_manquant");
    if (columnOf.has("direction") && !direction) warnings.push("direction_manquante");
    if ((columnOf.has("first_name") || columnOf.has("last_name")) && !firstName && !lastName) {
      warnings.push("auteur_manquant");
    }
    if (description.length < LIMITS.shortDescription) warnings.push("description_courte");

    const budget = columnOf.has("budget") ? parseBudget(budgetRaw) : { eur: null, flag: null };
    if (budget.flag) warnings.push(budget.flag);
    const date = columnOf.has("submitted_at") ? parseSubmittedDate(dateRaw) : { iso: null, flag: null };
    if (date.flag) warnings.push(date.flag);

    // Une cellule qui commence par = + - @ serait interprétée comme formule par un tableur.
    if (row.some(c => /^[=+\-@]/.test((c ?? "").trim()))) warnings.push("cellule_formule");

    const raw: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h && !personalColumns.has(i)) raw[h] = (row[i] ?? "").trim();
    });

    ideas.push({
      line,
      externalRef,
      title,
      description,
      expectedBenefits: benefits || null,
      direction: direction || null,
      site: site || null,
      theme: theme || null,
      budgetRaw: budgetRaw || null,
      budgetEur: budget.eur,
      submittedAt: date.iso,
      submittedAtRaw: dateRaw || null,
      author: firstName || lastName ? { firstName: firstName || null, lastName: lastName || null } : null,
      raw,
      warnings,
    });
  });

  const duplicates = findDuplicateCandidates(
    ideas.map(i => ({
      ref: i.externalRef,
      title: i.title,
      description: i.description,
      expectedBenefits: i.expectedBenefits,
    })),
  );

  return ok({
    rowsRead: dataRows.length - emptyLines.length,
    emptyLines,
    ideas,
    rejected,
    duplicates,
    ignoredColumns,
    missingOptionalFields,
  });
}

// ---------- Préparation de l'enregistrement ----------

export interface IdeaPayload {
  external_ref: string;
  title: string;
  description: string;
  expected_benefits: string | null;
  direction: string | null;
  site: string | null;
  theme: string | null;
  budget_raw: string | null;
  budget_eur: number | null;
  submitted_at: string | null;
  submitted_at_raw: string | null;
  content_hash: string;
  quality_flags: string[];
  raw: Record<string, string>;
  author: { first_name: string | null; last_name: string | null } | null;
}

export interface DuplicatePayload {
  ref_a: string;
  ref_b: string;
  kind: "exact" | "similar";
  similarity: number;
}

/** Synthèse de l'analyse, sans aucune donnée personnelle (stockée avec le lot d'import). */
export interface ImportReport {
  rows_read: number;
  rows_imported: number;
  rows_rejected: number;
  rows_empty: number;
  rows_excluded: number;
  warnings: Record<string, number>;
  errors: Record<string, number>;
  duplicates: { exact: number; similar: number };
  ignored_columns: string[];
}

export interface ImportPayload {
  ideas: IdeaPayload[];
  duplicates: DuplicatePayload[];
  report: ImportReport;
}

const countBy = (codes: string[]) =>
  codes.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c]: (acc[c] ?? 0) + 1 }), {});

/**
 * Construit le contenu envoyé à la base pour les idées retenues par l'utilisateur.
 * `hashOf` reçoit la clé de contenu normalisée et renvoie son empreinte (SHA-256, calculée hors domaine).
 */
export function buildImportPayload(
  analysis: ImportAnalysis,
  excludedRefs: ReadonlySet<string>,
  hashOf: (contentKey: string) => string,
): ImportPayload {
  const kept = analysis.ideas.filter(i => !excludedRefs.has(i.externalRef));
  const keptRefs = new Set(kept.map(i => i.externalRef));
  const duplicates = analysis.duplicates.filter(d => keptRefs.has(d.refA) && keptRefs.has(d.refB));

  return {
    ideas: kept.map(i => ({
      external_ref: i.externalRef,
      title: i.title,
      description: i.description,
      expected_benefits: i.expectedBenefits,
      direction: i.direction,
      site: i.site,
      theme: i.theme,
      budget_raw: i.budgetRaw,
      budget_eur: i.budgetEur,
      submitted_at: i.submittedAt,
      submitted_at_raw: i.submittedAtRaw,
      content_hash: hashOf(contentKey(i.title, i.description)),
      quality_flags: i.warnings,
      raw: i.raw,
      author: i.author ? { first_name: i.author.firstName, last_name: i.author.lastName } : null,
    })),
    duplicates: duplicates.map(d => ({ ref_a: d.refA, ref_b: d.refB, kind: d.kind, similarity: d.similarity })),
    report: {
      rows_read: analysis.rowsRead,
      rows_imported: kept.length,
      rows_rejected: analysis.rejected.length,
      rows_empty: analysis.emptyLines.length,
      rows_excluded: analysis.ideas.length - kept.length,
      warnings: countBy(kept.flatMap(i => i.warnings)),
      errors: countBy(analysis.rejected.flatMap(r => r.errors)),
      duplicates: {
        exact: duplicates.filter(d => d.kind === "exact").length,
        similar: duplicates.filter(d => d.kind === "similar").length,
      },
      ignored_columns: analysis.ignoredColumns,
    },
  };
}
