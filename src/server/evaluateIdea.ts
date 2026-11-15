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
import type { AgentCaller, AgentError, AgentUsage } from "./openrouter";

/**
 * Orchestration des agents pour une idée : analyste → 4 consultants en parallèle → associé.
 * Le transport est injecté (`call`) : testable sans réseau.
 */

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
  usage: AgentUsage & { calls: number };
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
  call: AgentCaller,
  agent: string,
  model: string,
  messages: ChatMessage[],
  schema: S,
  web: boolean,
  usage: AgentUsage & { calls: number },
): Promise<Result<{ data: z.infer<S>; citations: Parameters<typeof checkSources>[1]; model: string }, EvaluationError>> {
  // Une seconde tentative est autorisée si la réponse ne respecte pas le schéma : on renvoie
  // l'erreur au modèle. On ne « répare » jamais une réponse en inventant une valeur.
  let conversation = messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await call({ model, messages: conversation, schemaName: agent, schema: jsonSchemaOf(schema), web });
    if (!response.ok) return err({ code: response.error.code, agent, detail: response.error.detail });
    usage.calls += 1;
    usage.promptTokens += response.value.usage.promptTokens;
    usage.completionTokens += response.value.usage.completionTokens;
    usage.costUsd += response.value.usage.costUsd;

    const parsed = schema.safeParse(response.value.json);
    if (parsed.success) return ok({ data: parsed.data, citations: response.value.citations, model: response.value.model });
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
): Promise<Result<EvaluationResult, EvaluationError>> {
  if (input.criteria.length === 0) return err({ code: "aucun_critere", agent: "orchestrateur", detail: "grille vide" });
  const usage = { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };

  // 1. Analyste : estimation des données manquantes (uniquement si nécessaire).
  const missing = missingFields(input.idea);
  let analyst: AnalystOutput | null = null;
  let estimates: EstimateResult[] = [];
  if (missing.length > 0) {
    const r = await callValidated(
      call,
      "analyste",
      input.models.analyste,
      analystMessages(input.idea, input.challenge, missing, input.evaluatorNotes ?? null),
      analystOutputSchema,
      true,
      usage,
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
        call,
        `consultant_${criterion.key}`,
        input.models.consultant,
        criterionMessages(criterion, input.idea, input.challenge, analyst, input.evaluatorNotes ?? null),
        criterionOutputSchema,
        true,
        usage,
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
    call,
    "associe",
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
    usage,
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
