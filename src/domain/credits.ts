import { z } from "zod";

/**
 * Crédits IA (ADR 0003 §3) : conversion jetons → micro-euros (entiers, jamais de flottants en
 * base) selon un barème configurable par modèle, et estimation PESSIMISTE avant appel pour la
 * réservation. Pur et testable.
 */

export const MICRO = 1_000_000;

export interface ModelPrice {
  /** Euros par million de jetons en entrée. */
  input: number;
  /** Euros par million de jetons en sortie. */
  output: number;
}

export interface PriceTable {
  models: Record<string, ModelPrice>;
  fallback: ModelPrice;
}

const priceSchema = z.object({ input: z.number().min(0).max(1000), output: z.number().min(0).max(1000) });

/**
 * Barème lu depuis l'environnement : AI_PRICES_EUR_PER_MILLION = {"glm-5.2":{"input":…,"output":…}}
 * et un barème par défaut pour les modèles absents. Une valeur invalide est ignorée (repli).
 */
export function parsePriceTable(raw: string | undefined, fallback: ModelPrice): PriceTable {
  if (!raw?.trim()) return { models: {}, fallback };
  try {
    const parsed = z.record(z.string().min(1).max(120), priceSchema).safeParse(JSON.parse(raw));
    return { models: parsed.success ? parsed.data : {}, fallback };
  } catch {
    return { models: {}, fallback };
  }
}

export function priceFor(table: PriceTable, model: string): ModelPrice {
  return table.models[model] ?? table.fallback;
}

/** Coût d'un appel en micro-euros, arrondi au micro-euro supérieur (jamais sous-facturé). */
export function costMicroEur(table: PriceTable, model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(table, model);
  const tokens = (n: number) => Math.max(0, Math.floor(n));
  // € par million de jetons = µ€ par jeton.
  return Math.ceil(tokens(inputTokens) * p.input + tokens(outputTokens) * p.output);
}

/** Estimation prudente du nombre de jetons d'un texte (≈ 3 caractères par jeton en français). */
export const estimateTokens = (chars: number) => Math.ceil(chars / 3);

export interface PlannedCall {
  model: string;
  inputChars: number;
  /** Plafond de sortie (max_tokens) : on réserve le pire cas. */
  maxOutputTokens: number;
  /** Pages web injectées dans le contexte par la recherche (estimation forfaitaire). */
  webResults?: number;
}

const TOKENS_PER_WEB_RESULT = 800;

/** Réservation pessimiste pour une série d'appels prévus, avec une marge de sécurité. */
export function reservationMicroEur(table: PriceTable, calls: readonly PlannedCall[], margin = 1.2): number {
  const total = calls.reduce((sum, c) => {
    const input = estimateTokens(c.inputChars) + (c.webResults ?? 0) * TOKENS_PER_WEB_RESULT;
    return sum + costMicroEur(table, c.model, input, c.maxOutputTokens);
  }, 0);
  return Math.max(1, Math.ceil(total * margin));
}

/** Événement d'usage transmis à la régularisation (un par appel réel au fournisseur). */
export interface UsageEvent {
  agent: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_micro_eur: number;
  cached_tokens?: number;
  web_searches?: number;
}

export function usageEvent(
  table: PriceTable,
  agent: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  webSearches = 0,
): UsageEvent {
  return {
    agent,
    model,
    input_tokens: Math.max(0, Math.floor(inputTokens)),
    output_tokens: Math.max(0, Math.floor(outputTokens)),
    cost_micro_eur: costMicroEur(table, model, inputTokens, outputTokens),
    web_searches: webSearches,
  };
}

export const totalMicroEur = (events: readonly UsageEvent[]) => events.reduce((s, e) => s + e.cost_micro_eur, 0);

/** Affichage : « 3,42 € ». */
export function formatEuros(microEur: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    microEur / MICRO,
  );
}

export type CreditLevel = "ok" | "attention" | "epuise";

/** Alerte à 80 % de consommation, épuisé quand il ne reste rien. */
export function creditLevel(available: number, remaining: number): CreditLevel {
  if (remaining <= 0) return "epuise";
  if (available > 0 && remaining / available <= 0.2) return "attention";
  return "ok";
}
