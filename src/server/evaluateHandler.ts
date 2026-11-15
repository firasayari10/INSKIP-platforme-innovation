import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { PROMPT_VERSION, type CriterionForScoring } from "../domain/scoring";
import {
  evaluateIdea,
  type AgentModels,
  type CallParams,
  type EvaluationErrorCode,
  type EvaluationInput,
  type EvaluationOptions,
} from "./evaluateIdea";
import { createOpenRouterCaller, type AgentCaller } from "./openrouter";
import { createRateLimiter, type RateLimiter } from "./rateLimiter";
import { createSimulatedCaller } from "./simulatedLlm";
import { createZaiCaller } from "./zai";
import { evaluationInputKey } from "../domain/cache";
import { sha256Hex } from "../lib/hash";
import { createSupabaseAgentCache, type AgentCache } from "./agentCache";
import { evaluatorNotes } from "../domain/chat";

/**
 * POST /api/evaluate-idea  { ideaId, force? }  —  Authorization: Bearer <jeton de session>
 * 1. vérifie l'utilisateur et lit l'idée AVEC SES DROITS (RLS : il doit être membre du challenge) ;
 * 2. limite le nombre d'évaluations par utilisateur et par heure (protection du coût) ;
 * 3. réutilise une évaluation aux entrées strictement identiques (empreinte complète : idée,
 *    contexte, grille, informations de l'évaluateur, modèles, consignes) sauf `force` ; chaque
 *    agent consulte en plus le cache par agent du challenge (ADR 0003 §1) ;
 * 4. crée l'évaluation « en cours », répond aussitôt (202) et fait travailler les agents en
 *    arrière-plan ; le navigateur suit l'avancement en relisant l'évaluation.
 * Les résultats sont écrits avec la clé serveur : le navigateur ne peut jamais écrire lui-même une
 * « note IA » (CLAUDE.md §7). Aucun contenu d'idée n'est journalisé.
 */

export const envSchema = z
  .object({
    LLM_PROVIDER: z.enum(["zai", "openrouter", "simulation"]).optional(),
    SUPABASE_URL: z.url(),
    SUPABASE_PUBLISHABLE_KEY: z.string().min(10),
    SUPABASE_SECRET_KEY: z.string().min(10),
    // Z.ai (GLM)
    ZAI_API_KEY: z.string().min(10).optional(),
    ZAI_BASE_URL: z.url().default("https://api.z.ai/api/paas/v4"),
    ZAI_MODEL_ANALYSTE: z.string().min(3).default("glm-5.2"),
    ZAI_MODEL_CONSULTANT: z.string().min(3).default("glm-5.2"),
    ZAI_MODEL_ASSOCIE: z.string().min(3).default("glm-5.2"),
    ZAI_THINKING: z.enum(["true", "false"]).default("false"),
    // OpenRouter
    OPENROUTER_API_KEY: z.string().min(10).optional(),
    OPENROUTER_MODEL_ANALYSTE: z.string().min(3).default("anthropic/claude-haiku-5.5"),
    OPENROUTER_MODEL_CONSULTANT: z.string().min(3).default("anthropic/claude-haiku-5.5"),
    OPENROUTER_MODEL_ASSOCIE: z.string().min(3).default("anthropic/claude-sonnet-5.5"),
    // Commun
    WEB_MAX_RESULTS: z.coerce.number().int().min(1).max(10).default(5),
    LLM_MAX_CONCURRENT: z.coerce.number().int().min(1).max(20).default(2),
    LLM_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(20),
    LLM_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(500),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(180_000),
    EVALUATIONS_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(60),
    AGENT_CACHE_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
    CHAT_MESSAGES_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(120),
    APP_URL: z.url().default("http://localhost:3000"),
  })
  .transform(env => ({ ...env, provider: env.LLM_PROVIDER ?? (env.ZAI_API_KEY ? "zai" : "openrouter") }))
  .refine(env => env.provider === "simulation" || (env.provider === "zai" ? !!env.ZAI_API_KEY : !!env.OPENROUTER_API_KEY), {
    message: "clé du fournisseur d'IA manquante",
    path: ["provider"],
  });
export type ServerEnv = z.infer<typeof envSchema>;

const bodySchema = z.object({
  ideaId: z.uuid(),
  force: z.boolean().optional(),
  /** Réévaluer en tenant compte des informations données dans la conversation. */
  useChatNotes: z.boolean().optional(),
});

export type ApiErrorCode =
  | "methode_non_autorisee"
  | "service_non_configure"
  | "non_connecte"
  | "requete_invalide"
  | "idee_introuvable"
  | "evaluation_en_cours"
  | "trop_de_demandes"
  | "enregistrement_impossible"
  | EvaluationErrorCode;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
export const fail = (status: number, code: ApiErrorCode, headers?: Record<string, string>) => json(status, { error: code }, headers);

const RUNNING_TIMEOUT_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Limiteur partagé par toutes les évaluations de ce processus serveur (créé à la première requête).
let sharedLimiter: { key: string; limiter: RateLimiter } | null = null;
export function limiterFor(env: ServerEnv): RateLimiter {
  const key = `${env.LLM_MAX_CONCURRENT}/${env.LLM_REQUESTS_PER_MINUTE}/${env.LLM_MIN_INTERVAL_MS}`;
  if (sharedLimiter?.key !== key) {
    sharedLimiter = {
      key,
      limiter: createRateLimiter({
        maxConcurrent: env.LLM_MAX_CONCURRENT,
        requestsPerMinute: env.LLM_REQUESTS_PER_MINUTE,
        minIntervalMs: env.LLM_MIN_INTERVAL_MS,
      }),
    };
  }
  return sharedLimiter.limiter;
}

export function modelsFor(env: ServerEnv): AgentModels {
  if (env.provider === "simulation") return { analyste: "simulation", consultant: "simulation", associe: "simulation" };
  return env.provider === "zai"
    ? { analyste: env.ZAI_MODEL_ANALYSTE, consultant: env.ZAI_MODEL_CONSULTANT, associe: env.ZAI_MODEL_ASSOCIE }
    : { analyste: env.OPENROUTER_MODEL_ANALYSTE, consultant: env.OPENROUTER_MODEL_CONSULTANT, associe: env.OPENROUTER_MODEL_ASSOCIE };
}

/** Paramètres d'appel réellement envoyés au fournisseur : ils font partie de la clé de cache. */
export function callParamsFor(env: ServerEnv): CallParams {
  if (env.provider === "zai")
    return { provider: "zai", temperature: 0.2, maxTokens: 4096, thinking: env.ZAI_THINKING === "true", webCount: env.WEB_MAX_RESULTS };
  if (env.provider === "openrouter")
    return { provider: "openrouter", temperature: 0.2, maxTokens: 0, thinking: false, webCount: env.WEB_MAX_RESULTS };
  return { provider: "simulation", temperature: 0, maxTokens: 0, thinking: false, webCount: 0 };
}

export function callerFor(env: ServerEnv, limiter: RateLimiter): AgentCaller {
  // Aucun appel réseau ni jeton consommé (développement, démonstration).
  if (env.provider === "simulation") return createSimulatedCaller();
  if (env.provider === "zai") {
    return createZaiCaller({
      apiKey: env.ZAI_API_KEY!,
      baseUrl: env.ZAI_BASE_URL,
      webCount: env.WEB_MAX_RESULTS,
      timeoutMs: env.LLM_TIMEOUT_MS,
      thinking: env.ZAI_THINKING === "true",
      limiter,
    });
  }
  const openRouter = createOpenRouterCaller({
    apiKey: env.OPENROUTER_API_KEY!,
    webMaxResults: env.WEB_MAX_RESULTS,
    timeoutMs: env.LLM_TIMEOUT_MS,
    appUrl: env.APP_URL,
  });
  return request => limiter.run(() => openRouter(request));
}

export interface HandlerDeps {
  /** Transport des agents (remplaçable en test). */
  caller?: AgentCaller;
  createSupabase?: typeof createClient;
  /** Cache des sorties d'agents (par défaut : table agent_outputs ; remplaçable en test). */
  agentCache?: AgentCache;
  /** Prise en charge du travail d'arrière-plan (ex. `waitUntil` sur Vercel). */
  background?: (job: Promise<void>) => void;
}

export async function handleEvaluateIdea(
  request: Request,
  rawEnv: Record<string, string | undefined>,
  deps: HandlerDeps = {},
): Promise<Response> {
  if (request.method !== "POST") return fail(405, "methode_non_autorisee");

  const envParsed = envSchema.safeParse(rawEnv);
  if (!envParsed.success) {
    console.error("[evaluate-idea] configuration incomplète :", envParsed.error.issues.map(i => i.path.join(".")).join(", "));
    return fail(503, "service_non_configure");
  }
  const env = envParsed.data;
  const make = deps.createSupabase ?? createClient;

  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return fail(401, "non_connecte");

  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return fail(400, "requete_invalide");
    body = parsed.data;
  } catch {
    return fail(400, "requete_invalide");
  }

  // Client « utilisateur » : toutes les lectures passent par la RLS.
  const userDb: SupabaseClient = make(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userDb.auth.getUser(token);
  if (userError || !userData.user) return fail(401, "non_connecte");
  const userId = userData.user.id;

  const { data: idea } = await userDb
    .from("ideas")
    .select(
      "id, challenge_id, external_ref, title, description, expected_benefits, direction, site, theme, budget_raw, budget_eur, content_hash, challenges(client_name, title, context)",
    )
    .eq("id", body.ideaId)
    .maybeSingle();
  if (!idea) return fail(404, "idee_introuvable");

  const { data: criteriaRows } = await userDb
    .from("criteria")
    .select("id, key, label, description, weight, anchors")
    .eq("challenge_id", idea.challenge_id)
    .order("position");
  const criteria = (criteriaRows ?? []) as (CriterionForScoring & { id: string })[];
  const models = modelsFor(env);

  // Client « serveur » : seul autorisé à écrire les résultats des agents.
  const adminDb: SupabaseClient = make(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Informations de la discussion non encore prises en compte (réévaluation demandée).
  let notes: string | null = null;
  let noteMessageIds: string[] = [];
  if (body.useChatNotes) {
    const { data: chat } = await adminDb
      .from("idea_chat_messages")
      .select("id, content")
      .eq("idea_id", idea.id)
      .eq("role", "user")
      .is("used_for_evaluation_id", null)
      .order("created_at");
    notes = evaluatorNotes((chat ?? []).map(m => m.content as string));
    noteMessageIds = (chat ?? []).map(m => m.id as string);
  }

  const challenge = (Array.isArray(idea.challenges) ? idea.challenges[0] : idea.challenges) as {
    client_name: string;
    title: string;
    context: string | null;
  };
  const input: EvaluationInput = {
    idea: {
      external_ref: idea.external_ref,
      title: idea.title,
      description: idea.description,
      expected_benefits: idea.expected_benefits,
      direction: idea.direction,
      site: idea.site,
      theme: idea.theme,
      budget_raw: idea.budget_raw,
      budget_eur: idea.budget_eur === null ? null : Number(idea.budget_eur),
    },
    challenge,
    criteria: criteria.map(c => ({ ...c, weight: Number(c.weight), anchors: c.anchors ?? {} })),
    models,
    evaluatorNotes: notes,
  };
  // Empreinte de TOUTES les entrées (idée, contexte effectif, grille, notes, modèles, consignes) :
  // corrige D1 (empreinte limitée au titre et à la description) et D2 (ordre des clés jsonb).
  const inputFingerprint = await sha256Hex(
    evaluationInputKey({ ...input, models: { ...models }, evaluatorNotes: notes, promptVersion: PROMPT_VERSION, mode: "complete" }),
  );

  const { data: previous } = await adminDb
    .from("evaluations")
    .select("id, status, created_at, input_fingerprint")
    .eq("idea_id", idea.id)
    .order("created_at", { ascending: false })
    .limit(10);
  const running = (previous ?? []).find(
    e => e.status === "running" && Date.now() - new Date(e.created_at).getTime() < RUNNING_TIMEOUT_MS,
  );
  if (running) return json(202, { evaluationId: running.id, cached: false, status: "running" });
  const cached = (previous ?? []).find(e => e.status === "completed" && e.input_fingerprint === inputFingerprint);
  if (cached && !body.force) return json(200, { evaluationId: cached.id, cached: true, status: "completed" });

  // Quota par utilisateur : nombre d'évaluations lancées sur la dernière heure.
  const { count } = await adminDb
    .from("evaluations")
    .select("id", { count: "exact", head: true })
    .eq("requested_by", userId)
    .gte("created_at", new Date(Date.now() - HOUR_MS).toISOString());
  if ((count ?? 0) >= env.EVALUATIONS_PER_HOUR) return fail(429, "trop_de_demandes", { "Retry-After": "600" });

  // Un passage resté « en cours » au-delà du délai (serveur interrompu) est clos : la base
  // n'autorise qu'un passage en cours par idée.
  await adminDb
    .from("evaluations")
    .update({ status: "failed", error_code: "abandonnee" })
    .eq("idea_id", idea.id)
    .eq("status", "running")
    .lt("created_at", new Date(Date.now() - RUNNING_TIMEOUT_MS).toISOString());

  const { data: created, error: createError } = await adminDb
    .from("evaluations")
    .insert({
      challenge_id: idea.challenge_id,
      idea_id: idea.id,
      status: "running",
      prompt_version: PROMPT_VERSION,
      content_hash: idea.content_hash,
      input_fingerprint: inputFingerprint,
      models,
      requested_by: userId,
      evaluator_notes: notes,
    })
    .select("id")
    .single();
  if (createError?.code === "23505") return fail(409, "evaluation_en_cours"); // double clic, deux onglets
  if (createError || !created) {
    console.error("[evaluate-idea] création impossible :", createError?.code);
    return fail(500, "enregistrement_impossible");
  }

  const job = runAndStore({
    evaluationId: created.id,
    ideaId: idea.id,
    challengeId: idea.challenge_id,
    criteria,
    input,
    caller: deps.caller ?? callerFor(env, limiterFor(env)),
    adminDb,
    noteMessageIds,
    options: {
      cache: deps.agentCache ?? createSupabaseAgentCache(adminDb, idea.challenge_id, env.AGENT_CACHE_MAX_AGE_DAYS),
      useCache: !body.force,
      params: callParamsFor(env),
    },
  });
  if (deps.background) deps.background(job);
  else job.catch(e => console.error("[evaluate-idea] erreur inattendue :", e instanceof Error ? e.message : "inconnue"));

  return json(202, { evaluationId: created.id, cached: false, status: "running" });
}

async function runAndStore(args: {
  evaluationId: string;
  ideaId: string;
  challengeId: string;
  criteria: (CriterionForScoring & { id: string })[];
  input: EvaluationInput;
  caller: AgentCaller;
  adminDb: SupabaseClient;
  noteMessageIds: string[];
  options: EvaluationOptions;
}): Promise<void> {
  const { evaluationId, adminDb } = args;
  const markFailed = (code: string) =>
    adminDb.from("evaluations").update({ status: "failed", error_code: code }).eq("id", evaluationId);

  let result: Awaited<ReturnType<typeof evaluateIdea>>;
  try {
    result = await evaluateIdea(args.input, args.caller, args.options);
  } catch (e) {
    console.error("[evaluate-idea] exception :", e instanceof Error ? e.message : "inconnue");
    await markFailed("erreur_interne");
    return;
  }
  if (!result.ok) {
    console.error(`[evaluate-idea] échec ${result.error.agent} : ${result.error.code} (${result.error.detail})`);
    await markFailed(result.error.code);
    return;
  }

  const r = result.value;
  const idByKey = new Map(args.criteria.map(c => [c.key, c.id]));
  const { error: insertError } = await adminDb.from("criterion_assessments").insert(
    r.assessments.map(a => ({
      challenge_id: args.challengeId,
      evaluation_id: evaluationId,
      idea_id: args.ideaId,
      criterion_id: idByKey.get(a.criterionKey),
      ai_score: a.output.note,
      summary: a.output.resume,
      details: {
        sous_criteres: a.output.sous_criteres,
        arguments_pour: a.output.arguments_pour,
        arguments_contre: a.output.arguments_contre,
        hypotheses: a.output.hypotheses,
        donnees_manquantes: a.output.donnees_manquantes,
        confiance: a.output.confiance,
        sources_rejetees: a.rejectedSources,
      },
      sources: a.sources,
      model: a.model,
    })),
  );
  const { error: updateError } = insertError
    ? { error: insertError }
    : await adminDb
        .from("evaluations")
        .update({
          status: "completed",
          estimates: r.estimates,
          synthesis: { ...r.synthesis, note_globale_ia: r.aiGlobalScore },
          recommendation: r.synthesis.recommandation,
          web_sources_count: r.webSourcesCount,
          usage: r.usage,
          completed_at: new Date().toISOString(),
        })
        .eq("id", evaluationId);

  if (updateError) {
    console.error("[evaluate-idea] enregistrement impossible :", updateError.code);
    await markFailed("enregistrement_impossible");
    return;
  }
  // Les messages pris en compte sont rattachés à cette évaluation (traçabilité).
  if (args.noteMessageIds.length > 0) {
    await adminDb.from("idea_chat_messages").update({ used_for_evaluation_id: evaluationId }).in("id", args.noteMessageIds);
  }
}
