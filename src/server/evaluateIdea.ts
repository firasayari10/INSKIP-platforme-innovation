import type { z } from "zod";
import { err, ok, type Result } from "../domain/result";
import {
  analystMessages,
  analystOutputSchema,
  checkSources,
  criterionMessages,
  criterionOutputSchema,
  jsonSchemaOf,
  keepRequestedEstimates,
  missingFields,
  PROMPT_VERSION,
  synthesisMessages,
  synthesisOutputSchema,
  weightedAverage,
  type AnalystOutput,
  type ChallengeForScoring,
  type ChatMessage,
  type CheckedSources,
  type CriterionForScoring,
  type CriterionOutput,
  type IdeaForScoring,
  type SynthesisOutput,
} from "../domain/scoring";
import { agentRequestKey, type AgentCallParams } from "../domain/cache";
import { sha256Hex } from "../lib/hash";
import type { AgentCache, AgentRole } from "./agentCache";
import type { AgentCaller, AgentError, AgentUsage } from "./openrouter";

/**
 * Orchestration des agents pour une idée : analyste → 4 consultants en parallèle → associé.
 * Le transport est injecté (`call`) : testable sans réseau.
 * Chaque appel consulte d'abord le cache par agent (ADR 0003 §1) : une requête strictement
 * identique déjà traitée dans le même challenge n'est pas refacturée, et une évaluation
 * interrompue reprend sans rappeler les agents déjà terminés.
 */

/** Paramètres d'appel communs (hors modèle et recherche web, propres à chaque agent). */
export type CallParams = Omit<AgentCallParams, "model" | "web">;

export interface EvaluationOptions {
  cache?: AgentCache;
  /** `false` pour « Relancer l'évaluation » : pas de lecture du cache (l'écriture reste). */
  useCache?: boolean;
  params?: CallParams;
  /** Appelé après CHAQUE appel réel au fournisseur (y compris en cas d'échec ultérieur) : sert à
   *  facturer exactement ce qui a été consommé. Les réponses servies par le cache ne sont pas comptées. */
  onCall?: (call: ProviderCall) => void;
}

export interface ProviderCall {
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  webResults: number;
}

const DEFAULT_PARAMS: CallParams = { provider: "inconnu", temperature: 0.2, maxTokens: 4096, thinking: false, webCount: 5 };

type Usage = AgentUsage & { calls: number; cacheHits: number };

interface CallContext {
  call: AgentCaller;
  usage: Usage;
  cache?: AgentCache;
  useCache: boolean;
  params: CallParams;
  onCall?: (call: ProviderCall) => void;
}

export interface AgentModels {
  analyste: string;
  consultant: string;
  associe: string;
}

export interface EvaluationInput {
  idea: IdeaForScoring;
  challenge: ChallengeForScoring;
  criteria: CriterionForScoring[];
  models: AgentModels;
  /** Informations apportées par l'évaluateur dans la conversation (réévaluation). */
  evaluatorNotes?: string | null;
}

export interface EstimateResult {
  field: AnalystOutput["estimations"][number]["champ"];
  value: string;
  rangeMinEur: number | null;
  rangeMaxEur: number | null;
  method: string;
  assumptions: string[];
  confidence: string;
  sources: CheckedSources["kept"];
  rejectedSources: number;
}

export interface AssessmentResult {
  criterionKey: string;
  output: CriterionOutput;
  sources: CheckedSources["kept"];
  rejectedSources: number;
  model: string;
}

export interface EvaluationResult {
  promptVersion: string;
  estimates: EstimateResult[];
  assessments: AssessmentResult[];
  synthesis: SynthesisOutput;
  aiGlobalScore: number | null;
  usage: Usage;
  models: AgentModels;
  webSourcesCount: number;
}

export type EvaluationErrorCode = AgentError["code"] | "aucun_critere";

export interface EvaluationError {
  code: EvaluationErrorCode;
  /** Agent en cause, pour les journaux. */
  agent: string;
  detail: string;
}

async function callValidated<S extends z.ZodType>(
  ctx: CallContext,
  agent: string,
  role: AgentRole,
  criterionKey: string | null,
  model: string,
  messages: ChatMessage[],
  schema: S,
  web: boolean,
): Promise<Result<{ data: z.infer<S>; citations: Parameters<typeof checkSources>[1]; model: string }, EvaluationError>> {
  const { call, usage } = ctx;
  const jsonSchema = jsonSchemaOf(schema);
  const fingerprint = await sha256Hex(
    agentRequestKey({ schemaName: agent, schema: jsonSchema, messages }, { ...ctx.params, model, web }),
  );

  if (ctx.cache && ctx.useCache) {
    const hit = await ctx.cache.get(fingerprint);
    if (hit) {
      const parsed = schema.safeParse(hit.output);
      if (parsed.success) {
        usage.cacheHits += 1;
        return ok({ data: parsed.data, citations: hit.citations, model: hit.model });
      }
      console.error(`[agent-cache] cache_invalide ${fingerprint.slice(0, 8)} (${agent}) : entrée ignorée`);
    }
  }

  // Une seconde tentative est autorisée si la réponse ne respecte pas le schéma : on renvoie
  // l'erreur au modèle. On ne « répare » jamais une réponse en inventant une valeur.
  let conversation = messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await call({ model, messages: conversation, schemaName: agent, schema: jsonSchema, web });
    if (!response.ok) return err({ code: response.error.code, agent, detail: response.error.detail });
    usage.calls += 1;
    usage.promptTokens += response.value.usage.promptTokens;
    usage.completionTokens += response.value.usage.completionTokens;
    usage.costUsd += response.value.usage.costUsd;
    ctx.onCall?.({
      agent,
      model: response.value.model,
      inputTokens: response.value.usage.promptTokens,
      outputTokens: response.value.usage.completionTokens,
      webResults: response.value.citations.length,
    });

    const parsed = schema.safeParse(response.value.json);
    if (parsed.success) {
      await ctx.cache?.put({
        agent: role,
        criterionKey,
        fingerprint,
        promptVersion: PROMPT_VERSION,
        model: response.value.model,
        output: parsed.data,
        citations: response.value.citations,
        usage: { promptTokens: response.value.usage.promptTokens, completionTokens: response.value.usage.completionTokens },
      });
      return ok({ data: parsed.data, citations: response.value.citations, model: response.value.model });
    }
    conversation = [
      ...messages,
      {
        role: "user",
        content: `Ta réponse précédente ne respectait pas le format demandé (${parsed.error.issues
          .slice(0, 3)
          .map(i => `${i.path.join(".")} : ${i.message}`)
          .join(" ; ")}). Recommence en respectant strictement le schéma JSON.`,
      },
    ];
  }
  return err({ code: "reponse_invalide", agent, detail: "réponse hors schéma après deux tentatives" });
}

export async function evaluateIdea(
  input: EvaluationInput,
  call: AgentCaller,
  options: EvaluationOptions = {},
): Promise<Result<EvaluationResult, EvaluationError>> {
  if (input.criteria.length === 0) return err({ code: "aucun_critere", agent: "orchestrateur", detail: "grille vide" });
  const usage: Usage = { calls: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  const ctx: CallContext = {
    call,
    usage,
    cache: options.cache,
    useCache: options.useCache ?? true,
    params: options.params ?? DEFAULT_PARAMS,
    onCall: options.onCall,
  };

  // 1. Analyste : estimation des données manquantes (uniquement si nécessaire).
  const missing = missingFields(input.idea);
  let analyst: AnalystOutput | null = null;
  let estimates: EstimateResult[] = [];
  if (missing.length > 0) {
    const r = await callValidated(
      ctx,
      "analyste",
      "analyste",
      null,
      input.models.analyste,
      analystMessages(input.idea, input.challenge, missing, input.evaluatorNotes ?? null),
      analystOutputSchema,
      true,
    );
    if (!r.ok) return r;
    analyst = keepRequestedEstimates(r.value.data, missing);
    estimates = analyst.estimations.map(e => {
      const sources = checkSources(e.sources, r.value.citations);
      return {
        field: e.champ,
        value: e.valeur,
        rangeMinEur: e.fourchette_min_eur,
        rangeMaxEur: e.fourchette_max_eur,
        method: e.methode,
        assumptions: e.hypotheses,
        confidence: e.confiance,
        sources: sources.kept,
        rejectedSources: sources.rejected.length,
      };
    });
  }

  // 2. Consultants : un critère chacun, en parallèle, avec recherche web.
  const results = await Promise.all(
    input.criteria.map(criterion =>
      callValidated(
        ctx,
        `consultant_${criterion.key}`,
        "consultant",
        criterion.key,
        input.models.consultant,
        criterionMessages(criterion, input.idea, input.challenge, analyst, input.evaluatorNotes ?? null),
        criterionOutputSchema,
        true,
      ).then(r => ({ criterion, r })),
    ),
  );
  const failure = results.find(x => !x.r.ok);
  if (failure && !failure.r.ok) return failure.r;

  const assessments: AssessmentResult[] = results.map(({ criterion, r }) => {
    const value = (r as Extract<typeof r, { ok: true }>).value;
    const sources = checkSources(value.data.sources, value.citations);
    return {
      criterionKey: criterion.key,
      output: value.data,
      sources: sources.kept,
      rejectedSources: sources.rejected.length,
      model: value.model,
    };
  });

  const aiGlobalScore = weightedAverage(
    input.criteria.map(c => ({
      weight: c.weight,
      score: assessments.find(a => a.criterionKey === c.key)?.output.note ?? null,
    })),
  );

  // 3. Associé senior : synthèse et recommandation (sans recherche web, sans modifier les notes).
  const synthesis = await callValidated(
    ctx,
    "associe",
    "associe",
    null,
    input.models.associe,
    synthesisMessages(
      input.idea,
      input.challenge,
      analyst,
      input.criteria.map(c => ({ criterion: c, output: assessments.find(a => a.criterionKey === c.key)!.output })),
      aiGlobalScore,
      input.evaluatorNotes ?? null,
    ),
    synthesisOutputSchema,
    false,
  );
  if (!synthesis.ok) return synthesis;

  const webSourcesCount =
    estimates.reduce((n, e) => n + e.sources.length, 0) + assessments.reduce((n, a) => n + a.sources.length, 0);

  return ok({
    promptVersion: PROMPT_VERSION,
    estimates,
    assessments,
    synthesis: synthesis.value.data,
    aiGlobalScore,
    usage: { ...usage, costUsd: Math.round(usage.costUsd * 10_000) / 10_000 },
    models: input.models,
    webSourcesCount,
  });
}
