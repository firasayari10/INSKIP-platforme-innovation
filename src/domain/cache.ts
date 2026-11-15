import type { ChatMessage, ChallengeForScoring, CriterionForScoring, IdeaForScoring } from "./scoring";
import { effectiveContext } from "./scoring";

/**
 * Clés de cache des évaluations (ADR 0003 §1). Les chaînes renvoyées sont ensuite hachées en
 * SHA-256 côté serveur. Principe : la clé décrit EXACTEMENT ce que voit le modèle, si bien que
 * toute entrée qui change la requête invalide le cache, sans liste à maintenir à la main.
 */

/** JSON canonique : clés d'objet triées récursivement, propriétés `undefined` ignorées. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(v => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Compare deux jeux de modèles indépendamment de l'ordre des clés (jsonb les réordonne). */
export function sameModels(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  return canonicalJson(a) === canonicalJson(b);
}

/** Paramètres d'appel qui influencent la réponse du modèle. */
export interface AgentCallParams {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  thinking: boolean;
  web: boolean;
  webCount: number;
}

export const AGENT_KEY_VERSION = 1;

/** Clé d'un appel d'agent : messages initiaux + schéma + paramètres. */
export function agentRequestKey(
  request: { schemaName: string; schema: unknown; messages: ChatMessage[] },
  params: AgentCallParams,
): string {
  return canonicalJson({
    cle_v: AGENT_KEY_VERSION,
    provider: params.provider,
    model: params.model,
    temperature: params.temperature,
    max_tokens: params.maxTokens,
    thinking: params.thinking,
    web: params.web,
    web_count: params.web ? params.webCount : 0,
    schemaName: request.schemaName,
    schema: request.schema,
    messages: request.messages,
  });
}

/** Clé d'une évaluation complète : court-circuit « déjà évaluée avec exactement ces entrées ». */
export function evaluationInputKey(input: {
  idea: IdeaForScoring;
  challenge: ChallengeForScoring;
  criteria: CriterionForScoring[];
  models: Record<string, string>;
  evaluatorNotes: string | null | undefined;
  promptVersion: string;
  mode: string;
}): string {
  const { external_ref: _ref, ...ideaFields } = input.idea;
  return canonicalJson({
    idea: ideaFields,
    client: input.challenge.client_name,
    context: effectiveContext(input.challenge.context).text,
    criteria: input.criteria.map(c => ({
      key: c.key,
      label: c.label,
      description: c.description,
      weight: c.weight,
      anchors: c.anchors,
    })),
    models: input.models,
    notes: input.evaluatorNotes?.trim() || null,
    prompt_version: input.promptVersion,
    mode: input.mode,
  });
}
