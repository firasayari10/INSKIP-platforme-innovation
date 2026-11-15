import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  CHAT_MESSAGE_MAX,
  chatMessages,
  chatOutputSchema,
  extractMentions,
  type EvaluationDigest,
  type MentionedIdea,
} from "../domain/chat";
import { jsonSchemaOf, type IdeaForScoring } from "../domain/scoring";
import { callerFor, envSchema, fail, json, limiterFor, modelsFor } from "./evaluateHandler";
import type { AgentCaller } from "./openrouter";

/**
 * POST /api/idea-chat  { ideaId, message }  —  Authorization: Bearer <jeton de session>
 * L'évaluateur discute de la décision avec l'associé senior (IA). Le message peut mentionner
 * d'autres idées du même challenge (`@IDEA-007`). L'idée et les idées mentionnées sont lues AVEC
 * LE JETON de l'utilisateur (RLS) ; les deux messages sont enregistrés par le serveur seul.
 * Même limiteur de débit que les évaluations, plus un quota de messages par heure.
 */

const bodySchema = z.object({
  ideaId: z.uuid(),
  message: z.string().trim().min(1).max(CHAT_MESSAGE_MAX),
});

const IDEA_FIELDS =
  "id, challenge_id, external_ref, title, description, expected_benefits, direction, site, theme, budget_raw, budget_eur";

const HOUR_MS = 60 * 60 * 1000;

interface IdeaRow extends IdeaForScoring {
  id: string;
  challenge_id: string;
}

const toIdea = (r: IdeaRow): IdeaForScoring => ({
  external_ref: r.external_ref,
  title: r.title,
  description: r.description,
  expected_benefits: r.expected_benefits,
  direction: r.direction,
  site: r.site,
  theme: r.theme,
  budget_raw: r.budget_raw,
  budget_eur: r.budget_eur === null ? null : Number(r.budget_eur),
});

/** Dernière évaluation réussie d'une idée, résumée pour l'assistant. */
async function digestOf(db: SupabaseClient, ideaId: string, detailed: boolean): Promise<EvaluationDigest | null> {
  const { data } = await db
    .from("evaluations")
    .select(
      "synthesis, recommendation, estimates, criterion_assessments(ai_score, summary, details, criteria(label, position))",
    )
    .eq("idea_id", ideaId)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  type Assessment = {
    ai_score: number;
    summary: string;
    details: { sous_criteres?: { nom: string; note: number; commentaire: string }[]; hypotheses?: string[]; arguments_contre?: string[] };
    criteria: { label: string; position: number } | { label: string; position: number }[] | null;
  };
  const criterionOf = (a: Assessment) => (Array.isArray(a.criteria) ? a.criteria[0] : a.criteria);
  const assessments = ((data.criterion_assessments ?? []) as Assessment[]).sort(
    (x, y) => (criterionOf(x)?.position ?? 0) - (criterionOf(y)?.position ?? 0),
  );
  const synthesis = data.synthesis as { synthese?: string; note_globale_ia?: number | null } | null;
  return {
    globalScore: synthesis?.note_globale_ia ?? null,
    recommendation: (data.recommendation as string | null) ?? null,
    synthesis: synthesis?.synthese ?? null,
    criteria: assessments.map(a => ({
      label: criterionOf(a)?.label ?? "Critère",
      score: a.ai_score,
      summary: a.summary,
      details: detailed
        ? [
            ...(a.details.sous_criteres ?? []).map(s => `${s.nom} ${s.note}/5 (${s.commentaire})`),
            ...(a.details.arguments_contre ?? []).map(c => `contre : ${c}`),
            ...(a.details.hypotheses ?? []).map(h => `hypothèse : ${h}`),
          ].join(" ; ")
        : "",
    })),
    estimates: ((data.estimates ?? []) as { field: string; value: string }[]).map(e => `${e.field} ≈ ${e.value}`),
  };
}

export interface ChatDeps {
  caller?: AgentCaller;
  createSupabase?: typeof createClient;
}

export async function handleIdeaChat(
  request: Request,
  rawEnv: Record<string, string | undefined>,
  deps: ChatDeps = {},
): Promise<Response> {
  if (request.method !== "POST") return fail(405, "methode_non_autorisee");
  const envParsed = envSchema.safeParse(rawEnv);
  if (!envParsed.success) return fail(503, "service_non_configure");
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

  const userDb: SupabaseClient = make(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userDb.auth.getUser(token);
  if (userError || !userData.user) return fail(401, "non_connecte");
  const userId = userData.user.id;

  const { data: idea } = await userDb
    .from("ideas")
    .select(`${IDEA_FIELDS}, challenges(client_name, title, context)`)
    .eq("id", body.ideaId)
    .maybeSingle();
  if (!idea) return fail(404, "idee_introuvable");

  const adminDb: SupabaseClient = make(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { count } = await adminDb
    .from("idea_chat_messages")
    .select("id", { count: "exact", head: true })
    .eq("author_id", userId)
    .gte("created_at", new Date(Date.now() - HOUR_MS).toISOString());
  if ((count ?? 0) >= env.CHAT_MESSAGES_PER_HOUR) return fail(429, "trop_de_demandes", { "Retry-After": "600" });

  // Idées mentionnées : même challenge, lues avec les droits de l'utilisateur.
  const refs = extractMentions(body.message);
  let mentionedRows: IdeaRow[] = [];
  if (refs.length > 0) {
    const variants = [...new Set(refs.flatMap(r => [r, r.toUpperCase(), r.toLowerCase()]))];
    const { data } = await userDb
      .from("ideas")
      .select(IDEA_FIELDS)
      .eq("challenge_id", idea.challenge_id)
      .in("external_ref", variants)
      .neq("id", idea.id);
    mentionedRows = (data ?? []) as IdeaRow[];
  }
  const mentioned: MentionedIdea[] = await Promise.all(
    mentionedRows.map(async row => ({ idea: toIdea(row), evaluation: await digestOf(userDb, row.id, false) })),
  );

  const { data: historyRows } = await adminDb
    .from("idea_chat_messages")
    .select("role, content")
    .eq("idea_id", idea.id)
    // Question et réponse ont le même horodatage : à égalité, la réponse est la plus récente.
    .order("created_at", { ascending: false })
    .order("role", { ascending: true })
    .limit(16);
  const history = ((historyRows ?? []) as { role: "user" | "assistant"; content: string }[]).reverse();

  const challenge = (Array.isArray(idea.challenges) ? idea.challenges[0] : idea.challenges) as {
    client_name: string;
    title: string;
    context: string | null;
  };
  const messages = chatMessages({
    idea: toIdea(idea as unknown as IdeaRow),
    challenge,
    evaluation: await digestOf(userDb, idea.id, true),
    mentioned,
    history,
    question: body.message,
  });

  const caller = deps.caller ?? callerFor(env, limiterFor(env));
  const model = modelsFor(env).associe;
  let output: z.infer<typeof chatOutputSchema> | null = null;
  let usedModel = model;
  for (let attempt = 0; attempt < 2 && !output; attempt++) {
    const r = await caller({ model, messages, schemaName: "conversation", schema: jsonSchemaOf(chatOutputSchema), web: false });
    if (!r.ok) {
      console.error(`[idea-chat] échec : ${r.error.code} (${r.error.detail})`);
      return fail(502, r.error.code);
    }
    const parsed = chatOutputSchema.safeParse(r.value.json);
    if (parsed.success) {
      output = parsed.data;
      usedModel = r.value.model;
    }
  }
  if (!output) return fail(502, "reponse_invalide");

  const found = mentionedRows.map(r => r.external_ref);
  const { data: saved, error: saveError } = await adminDb
    .from("idea_chat_messages")
    .insert([
      {
        challenge_id: idea.challenge_id,
        idea_id: idea.id,
        role: "user",
        author_id: userId,
        content: body.message,
        referenced_refs: found,
      },
      {
        challenge_id: idea.challenge_id,
        idea_id: idea.id,
        role: "assistant",
        author_id: null,
        content: output.reponse,
        referenced_refs: found,
        model: usedModel,
      },
    ])
    .select("id, role, content, referenced_refs, created_at, used_for_evaluation_id");
  if (saveError) {
    console.error("[idea-chat] enregistrement impossible :", saveError.code);
    return fail(500, "enregistrement_impossible");
  }

  return json(200, {
    messages: saved,
    informations: output.informations_apportees,
    suggestReevaluation: output.suggere_reevaluation,
    unknownRefs: refs.filter(r => !found.some(f => f.toUpperCase() === r.toUpperCase())),
  });
}
