import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { err, ok, type Result } from "@/domain/result";
import { RECOMMENDATIONS } from "@/domain/scoring";
import type { DataError } from "./data";

/**
 * Accès aux données de la notation. Les résultats des agents sont LUS ici (RLS : membres du
 * challenge) ; ils ne sont écrits que par le serveur. Le navigateur n'écrit que la note humaine.
 */

function toError(code: string | undefined, message?: string): DataError {
  if (code === "42501" || code === "PGRST301") return "acces_refuse";
  if (code === "PGRST116") return "introuvable";
  if (code && ["PGRST205", "PGRST202", "42P01", "42703"].includes(code)) return "service_non_initialise";
  if (code && ["22023", "23514", "23502", "22P02"].includes(code)) return "donnees_invalides";
  if (!code && message && /fetch|network/i.test(message)) return "reseau";
  return "inconnue";
}

// ---------- Contexte du client ----------

export const CONTEXT_MAX = 8000;

export async function getChallengeContext(
  client: SupabaseClient,
  challengeId: string,
): Promise<Result<string | null, DataError>> {
  const { data, error } = await client.from("challenges").select("context").eq("id", challengeId).single();
  if (error) return err(toError(error.code, error.message));
  const parsed = z.object({ context: z.string().nullable() }).safeParse(data);
  return parsed.success ? ok(parsed.data.context) : err("donnees_invalides");
}

export async function saveChallengeContext(
  client: SupabaseClient,
  challengeId: string,
  context: string,
): Promise<Result<true, DataError>> {
  const value = context.trim().slice(0, CONTEXT_MAX);
  const { error } = await client
    .from("challenges")
    .update({ context: value === "" ? null : value })
    .eq("id", challengeId);
  return error ? err(toError(error.code, error.message)) : ok(true);
}

// ---------- Évaluation d'une idée ----------

const sourceSchema = z.object({ title: z.string(), url: z.string(), excerpt: z.string() });
export type Source = z.infer<typeof sourceSchema>;

const estimateSchema = z.object({
  field: z.string(),
  value: z.string(),
  rangeMinEur: z.number().nullable(),
  rangeMaxEur: z.number().nullable(),
  method: z.string(),
  assumptions: z.array(z.string()),
  confidence: z.string(),
  sources: z.array(sourceSchema),
  rejectedSources: z.number(),
});
export type Estimate = z.infer<typeof estimateSchema>;

const synthesisSchema = z.object({
  synthese: z.string(),
  points_forts: z.array(z.string()),
  points_faibles: z.array(z.string()),
  incoherences: z.array(z.string()),
  recommandation: z.enum(RECOMMENDATIONS),
  justification_recommandation: z.string(),
  prochaines_etapes: z.array(z.string()),
  note_globale_ia: z.number().nullable(),
});
export type Synthesis = z.infer<typeof synthesisSchema>;

const detailsSchema = z.object({
  sous_criteres: z.array(z.object({ nom: z.string(), note: z.number(), commentaire: z.string() })),
  arguments_pour: z.array(z.string()),
  arguments_contre: z.array(z.string()),
  hypotheses: z.array(z.string()),
  donnees_manquantes: z.array(z.string()),
  confiance: z.string(),
  sources_rejetees: z.number().optional(),
});

const criterionSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  label: z.string(),
  description: z.string(),
  weight: z.coerce.number(),
  position: z.number(),
});
export type Criterion = z.infer<typeof criterionSchema>;

const assessmentSchema = z.object({
  id: z.uuid(),
  criterion_id: z.uuid(),
  ai_score: z.number(),
  summary: z.string(),
  details: detailsSchema,
  sources: z.array(sourceSchema),
  model: z.string(),
});
export type Assessment = z.infer<typeof assessmentSchema>;

const evaluationSchema = z.object({
  id: z.uuid(),
  status: z.enum(["running", "completed", "failed"]),
  prompt_version: z.string(),
  models: z.record(z.string(), z.string()),
  estimates: z.array(estimateSchema),
  synthesis: synthesisSchema.nullable(),
  recommendation: z.enum(RECOMMENDATIONS).nullable(),
  web_sources_count: z.number(),
  usage: z.object({ costUsd: z.number().optional(), calls: z.number().optional() }).passthrough(),
  error_code: z.string().nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
  criterion_assessments: z.array(assessmentSchema),
});
export type Evaluation = z.infer<typeof evaluationSchema>;

const scoreSchema = z.object({
  criterion_id: z.uuid(),
  final_score: z.number(),
  final_comment: z.string().nullable(),
  validated_at: z.string(),
});
export type HumanScore = z.infer<typeof scoreSchema>;

export interface IdeaScoring {
  criteria: Criterion[];
  evaluation: Evaluation | null;
  scores: HumanScore[];
}

export async function getIdeaScoring(
  client: SupabaseClient,
  challengeId: string,
  ideaId: string,
): Promise<Result<IdeaScoring, DataError>> {
  const [criteria, evaluation, scores] = await Promise.all([
    client.from("criteria").select("id, key, label, description, weight, position").eq("challenge_id", challengeId).order("position"),
    client
      .from("evaluations")
      .select(
        "id, status, prompt_version, models, estimates, synthesis, recommendation, web_sources_count, usage, error_code, created_at, completed_at, criterion_assessments(id, criterion_id, ai_score, summary, details, sources, model)",
      )
      .eq("idea_id", ideaId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    client.from("scores").select("criterion_id, final_score, final_comment, validated_at").eq("idea_id", ideaId),
  ]);
  const firstError = criteria.error ?? evaluation.error ?? scores.error;
  if (firstError) return err(toError(firstError.code, firstError.message));

  const c = z.array(criterionSchema).safeParse(criteria.data);
  const e = evaluation.data === null ? { success: true as const, data: null } : evaluationSchema.safeParse(evaluation.data);
  const s = z.array(scoreSchema).safeParse(scores.data);
  if (!c.success || !e.success || !s.success) return err("donnees_invalides");
  return ok({ criteria: c.data, evaluation: e.data, scores: s.data });
}

export async function saveHumanScore(
  client: SupabaseClient,
  input: {
    challengeId: string;
    ideaId: string;
    criterionId: string;
    score: number;
    comment: string;
    assessmentId: string | null;
  },
): Promise<Result<true, DataError>> {
  if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) return err("donnees_invalides");
  const comment = input.comment.trim().slice(0, 2000);
  const { error } = await client.from("scores").upsert(
    {
      challenge_id: input.challengeId,
      idea_id: input.ideaId,
      criterion_id: input.criterionId,
      final_score: input.score,
      final_comment: comment === "" ? null : comment,
      based_on_assessment_id: input.assessmentId,
    },
    { onConflict: "idea_id,criterion_id" },
  );
  return error ? err(toError(error.code, error.message)) : ok(true);
}

export async function removeHumanScore(
  client: SupabaseClient,
  ideaId: string,
  criterionId: string,
): Promise<Result<true, DataError>> {
  const { error } = await client.from("scores").delete().eq("idea_id", ideaId).eq("criterion_id", criterionId);
  return error ? err(toError(error.code, error.message)) : ok(true);
}

// ---------- Lancement des agents (fonction serveur) ----------

export type EvaluationRequestError =
  | "non_connecte"
  | "idee_introuvable"
  | "evaluation_en_cours"
  | "trop_de_demandes"
  | "credit_ia_epuise"
  | "credit_indisponible"
  | "evaluation_echouee"
  | "service_non_configure"
  | "cle_invalide"
  | "credit_insuffisant"
  | "modele_indisponible"
  | "quota_depasse"
  | "delai_depasse"
  | "reponse_invalide"
  | "reseau"
  | "inconnue";

const KNOWN: ReadonlySet<string> = new Set([
  "non_connecte",
  "idee_introuvable",
  "evaluation_en_cours",
  "trop_de_demandes",
  "credit_ia_epuise",
  "credit_indisponible",
  "service_non_configure",
  "cle_invalide",
  "credit_insuffisant",
  "modele_indisponible",
  "quota_depasse",
  "delai_depasse",
  "reponse_invalide",
  "reseau",
]);

export async function requestEvaluation(
  accessToken: string,
  ideaId: string,
  force: boolean,
  useChatNotes = false,
): Promise<Result<{ evaluationId: string; cached: boolean; status: "running" | "completed" }, EvaluationRequestError>> {
  let response: Response;
  try {
    response = await fetch("/api/evaluate-idea", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ ideaId, force, useChatNotes }),
    });
  } catch {
    return err("reseau");
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = z
      .object({ evaluationId: z.string(), cached: z.boolean(), status: z.enum(["running", "completed"]) })
      .safeParse(body);
    return parsed.success ? ok(parsed.data) : err("inconnue");
  }
  const code = z.object({ error: z.string() }).safeParse(body);
  return err(code.success && KNOWN.has(code.data.error) ? (code.data.error as EvaluationRequestError) : "inconnue");
}

// ---------- Vue d'ensemble d'un challenge ----------

export interface EvaluationSummary {
  status: "running" | "completed" | "failed";
  aiScore: number | null;
  recommendation: (typeof RECOMMENDATIONS)[number] | null;
}

const summaryRowSchema = z.object({
  idea_id: z.uuid(),
  status: z.enum(["running", "completed", "failed"]),
  ai_score: z.number().nullable(),
  recommendation: z.enum(RECOMMENDATIONS).nullable(),
});

/** Dernière évaluation de chaque idée du challenge (statut, note proposée, recommandation). */
export async function listEvaluationSummaries(
  client: SupabaseClient,
  challengeId: string,
): Promise<Result<Map<string, EvaluationSummary>, DataError>> {
  const { data, error } = await client
    .from("evaluations")
    .select("idea_id, status, ai_score:synthesis->note_globale_ia, recommendation, created_at")
    .eq("challenge_id", challengeId)
    .order("created_at", { ascending: false });
  if (error) return err(toError(error.code, error.message));
  const parsed = z.array(summaryRowSchema).safeParse(data);
  if (!parsed.success) return err("donnees_invalides");
  const latest = new Map<string, EvaluationSummary>();
  for (const row of parsed.data) {
    if (!latest.has(row.idea_id)) {
      latest.set(row.idea_id, { status: row.status, aiScore: row.ai_score, recommendation: row.recommendation });
    }
  }
  return ok(latest);
}

/** État d'une évaluation (pour suivre un passage lancé en arrière-plan). */
export async function getEvaluationStatus(
  client: SupabaseClient,
  evaluationId: string,
): Promise<Result<{ status: "running" | "completed" | "failed"; errorCode: string | null }, DataError>> {
  const { data, error } = await client.from("evaluations").select("status, error_code").eq("id", evaluationId).single();
  if (error) return err(toError(error.code, error.message));
  const parsed = z.object({ status: z.enum(["running", "completed", "failed"]), error_code: z.string().nullable() }).safeParse(data);
  return parsed.success ? ok({ status: parsed.data.status, errorCode: parsed.data.error_code }) : err("donnees_invalides");
}

const POLL_INTERVAL_MS = 4_000;
const MAX_WAIT_MS = 15 * 60 * 1000;

/**
 * Lance l'évaluation d'une idée puis attend qu'elle soit terminée (le serveur répond aussitôt et
 * travaille en arrière-plan). `shouldStop` permet d'abandonner l'attente (page quittée).
 */
export async function evaluateAndWait(
  client: SupabaseClient,
  accessToken: string,
  ideaId: string,
  force: boolean,
  shouldStop: () => boolean = () => false,
  useChatNotes = false,
): Promise<Result<{ evaluationId: string }, EvaluationRequestError>> {
  const started = await requestEvaluation(accessToken, ideaId, force, useChatNotes);
  if (!started.ok) return started;
  if (started.value.status === "completed") return ok({ evaluationId: started.value.evaluationId });
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline && !shouldStop()) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const s = await getEvaluationStatus(client, started.value.evaluationId);
    if (!s.ok) continue; // incident réseau passager : on réessaie au tour suivant
    if (s.value.status === "completed") return ok({ evaluationId: started.value.evaluationId });
    if (s.value.status === "failed") {
      const code = s.value.errorCode ?? "";
      return err(KNOWN.has(code) ? (code as EvaluationRequestError) : "evaluation_echouee");
    }
  }
  return err("delai_depasse");
}

// ---------- Conversation sur une idée ----------

const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  referenced_refs: z.array(z.string()),
  created_at: z.string(),
  used_for_evaluation_id: z.string().nullable(),
});
export type ChatMessageRow = z.infer<typeof chatMessageSchema>;

export async function listChatMessages(
  client: SupabaseClient,
  ideaId: string,
): Promise<Result<ChatMessageRow[], DataError>> {
  const { data, error } = await client
    .from("idea_chat_messages")
    .select("id, role, content, referenced_refs, created_at, used_for_evaluation_id")
    .eq("idea_id", ideaId)
    // À horodatage égal, la question (user) précède la réponse (assistant).
    .order("created_at")
    .order("role", { ascending: false })
    .limit(200);
  if (error) return err(toError(error.code, error.message));
  const parsed = z.array(chatMessageSchema).safeParse(data);
  return parsed.success ? ok(parsed.data) : err("donnees_invalides");
}

export interface ChatReply {
  messages: ChatMessageRow[];
  informations: string[];
  suggestReevaluation: boolean;
  unknownRefs: string[];
}

export async function sendChatMessage(
  accessToken: string,
  ideaId: string,
  message: string,
): Promise<Result<ChatReply, EvaluationRequestError>> {
  let response: Response;
  try {
    response = await fetch("/api/idea-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ ideaId, message }),
    });
  } catch {
    return err("reseau");
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = z
      .object({
        messages: z.array(chatMessageSchema),
        informations: z.array(z.string()),
        suggestReevaluation: z.boolean(),
        unknownRefs: z.array(z.string()),
      })
      .safeParse(body);
    return parsed.success ? ok(parsed.data) : err("inconnue");
  }
  const code = z.object({ error: z.string() }).safeParse(body);
  return err(code.success && KNOWN.has(code.data.error) ? (code.data.error as EvaluationRequestError) : "inconnue");
}

/** Idées du challenge proposables dans une mention @ (identifiant et titre seulement). */
export async function listMentionCandidates(
  client: SupabaseClient,
  challengeId: string,
): Promise<Result<{ id: string; external_ref: string; title: string }[], DataError>> {
  const { data, error } = await client
    .from("ideas")
    .select("id, external_ref, title")
    .eq("challenge_id", challengeId)
    .order("external_ref");
  if (error) return err(toError(error.code, error.message));
  const parsed = z.array(z.object({ id: z.string(), external_ref: z.string(), title: z.string() })).safeParse(data);
  return parsed.success ? ok(parsed.data) : err("donnees_invalides");
}

// ---------- Crédits IA de l'utilisateur ----------

/** Notifie l'en-tête qu'une consommation vient d'avoir lieu (rafraîchit l'indicateur de crédits). */
export const notifyCreditChanged = () => window.dispatchEvent(new Event("ai-credit-changed"));

const creditSchema = z.object({
  month: z.string(),
  allocation_micro_eur: z.coerce.number(),
  granted_micro_eur: z.coerce.number(),
  consumed_micro_eur: z.coerce.number(),
  reserved_micro_eur: z.coerce.number(),
  remaining_micro_eur: z.coerce.number(),
  evaluations_count: z.coerce.number(),
  discussion_messages_count: z.coerce.number(),
});
export type MyCredit = z.infer<typeof creditSchema>;

export async function getMyCredit(client: SupabaseClient): Promise<Result<MyCredit, DataError>> {
  const { data, error } = await client.rpc("my_ai_credit");
  if (error) return err(toError(error.code, error.message));
  const row = Array.isArray(data) ? data[0] : data;
  const parsed = creditSchema.safeParse(row);
  return parsed.success ? ok(parsed.data) : err("donnees_invalides");
}

const usageRowSchema = z.object({
  id: z.coerce.number(),
  kind: z.enum(["usage", "grant"]),
  amount_micro_eur: z.coerce.number(),
  operation: z.string().nullable(),
  agent: z.string().nullable(),
  model: z.string().nullable(),
  input_tokens: z.coerce.number().nullable(),
  output_tokens: z.coerce.number().nullable(),
  created_at: z.string(),
});
export type UsageRow = z.infer<typeof usageRowSchema>;

/** Dernières lignes du journal de consommation de l'utilisateur (RLS : les siennes seulement). */
export async function listMyUsage(client: SupabaseClient, limit = 15): Promise<Result<UsageRow[], DataError>> {
  const { data, error } = await client
    .from("ai_credit_ledger")
    .select("id, kind, amount_micro_eur, operation, agent, model, input_tokens, output_tokens, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return err(toError(error.code, error.message));
  const parsed = z.array(usageRowSchema).safeParse(data);
  return parsed.success ? ok(parsed.data) : err("donnees_invalides");
}
