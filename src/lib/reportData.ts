import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { err, ok, type Result } from "@/domain/result";
import { weightedAverage, RECOMMENDATIONS } from "@/domain/scoring";
import type { DataError } from "./data";

/**
 * Données du rapport final (lecture seule, sous la RLS de l'utilisateur). Aucune donnée
 * personnelle n'est chargée : le rapport est anonyme (pas de lecture de idea_authors).
 */

const PAGE = 1_000; // limite par requête de l'API Supabase

/** Lit toutes les lignes d'une requête, page par page (sinon l'API tronque à 1 000 lignes). */
async function fetchAll<T>(
  query: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { code?: string; message: string } | null }>,
): Promise<Result<T[], DataError>> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) return err(error.code === "42501" ? "acces_refuse" : "inconnue");
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return ok(rows);
  }
}

const challengeSchema = z.object({
  id: z.string(),
  title: z.string(),
  client_name: z.string(),
  jury_date: z.string().nullable(),
  shortlist_size: z.number(),
  context: z.string().nullable(),
});

const criterionSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  description: z.string(),
  weight: z.coerce.number(),
  position: z.number(),
});
export type ReportCriterion = z.infer<typeof criterionSchema>;

const ideaSchema = z.object({
  id: z.string(),
  external_ref: z.string(),
  title: z.string(),
  description: z.string(),
  expected_benefits: z.string().nullable(),
  direction: z.string().nullable(),
  site: z.string().nullable(),
  theme: z.string().nullable(),
  budget_raw: z.string().nullable(),
  budget_eur: z.coerce.number().nullable(),
});

const synthesisSchema = z
  .object({
    synthese: z.string(),
    points_forts: z.array(z.string()),
    points_faibles: z.array(z.string()),
    incoherences: z.array(z.string()),
    justification_recommandation: z.string(),
    prochaines_etapes: z.array(z.string()),
    note_globale_ia: z.number().nullable(),
  })
  .partial()
  .passthrough();

const evaluationSchema = z.object({
  idea_id: z.string(),
  created_at: z.string(),
  recommendation: z.enum(RECOMMENDATIONS).nullable(),
  synthesis: synthesisSchema.nullable(),
  web_sources_count: z.number(),
  estimates: z.array(z.object({ field: z.string(), value: z.string() }).passthrough()),
  criterion_assessments: z.array(z.object({ criterion_id: z.string(), ai_score: z.number(), summary: z.string() })),
});

const scoreSchema = z.object({
  idea_id: z.string(),
  criterion_id: z.string(),
  final_score: z.number(),
  final_comment: z.string().nullable(),
});

export interface ReportCriterionScore {
  criterion: ReportCriterion;
  score: number | null;
  validated: boolean;
  summary: string | null;
  comment: string | null;
}

export interface ReportIdea {
  idea: z.infer<typeof ideaSchema>;
  aiScore: number | null;
  validatedScore: number | null;
  recommendation: (typeof RECOMMENDATIONS)[number] | null;
  synthesis: z.infer<typeof synthesisSchema> | null;
  criteria: ReportCriterionScore[];
  estimates: { field: string; value: string }[];
  webSources: number;
  evaluatedAt: string | null;
}

export interface ChallengeReport {
  challenge: z.infer<typeof challengeSchema>;
  criteria: ReportCriterion[];
  ideas: ReportIdea[];
  confirmedDuplicates: [string, string][];
}

export async function getChallengeReport(
  client: SupabaseClient,
  challengeId: string,
): Promise<Result<ChallengeReport, DataError>> {
  const { data: challengeRow, error: challengeError } = await client
    .from("challenges")
    .select("id, title, client_name, jury_date, shortlist_size, context")
    .eq("id", challengeId)
    .single();
  if (challengeError) return err(challengeError.code === "PGRST116" ? "introuvable" : "inconnue");
  const challenge = challengeSchema.safeParse(challengeRow);
  if (!challenge.success) return err("donnees_invalides");

  const [criteriaRes, ideasRes, evalsRes, scoresRes, dupRes] = await Promise.all([
    fetchAll<unknown>((a, b) =>
      client.from("criteria").select("id, key, label, description, weight, position").eq("challenge_id", challengeId).order("position").range(a, b),
    ),
    fetchAll<unknown>((a, b) =>
      client
        .from("ideas")
        .select("id, external_ref, title, description, expected_benefits, direction, site, theme, budget_raw, budget_eur")
        .eq("challenge_id", challengeId)
        .order("external_ref")
        .range(a, b),
    ),
    fetchAll<unknown>((a, b) =>
      client
        .from("evaluations")
        .select("idea_id, created_at, recommendation, synthesis, web_sources_count, estimates, criterion_assessments(criterion_id, ai_score, summary)")
        .eq("challenge_id", challengeId)
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .range(a, b),
    ),
    fetchAll<unknown>((a, b) =>
      client.from("scores").select("idea_id, criterion_id, final_score, final_comment").eq("challenge_id", challengeId).range(a, b),
    ),
    fetchAll<unknown>((a, b) =>
      client.from("duplicate_pairs").select("idea_a, idea_b").eq("challenge_id", challengeId).eq("status", "confirmed").range(a, b),
    ),
  ]);
  for (const r of [criteriaRes, ideasRes, evalsRes, scoresRes, dupRes]) if (!r.ok) return r as Result<never, DataError>;

  const criteria = z.array(criterionSchema).safeParse((criteriaRes as { value: unknown[] }).value);
  const ideas = z.array(ideaSchema).safeParse((ideasRes as { value: unknown[] }).value);
  const evals = z.array(evaluationSchema).safeParse((evalsRes as { value: unknown[] }).value);
  const scores = z.array(scoreSchema).safeParse((scoresRes as { value: unknown[] }).value);
  const dups = z.array(z.object({ idea_a: z.string(), idea_b: z.string() })).safeParse((dupRes as { value: unknown[] }).value);
  if (!criteria.success || !ideas.success || !evals.success || !scores.success || !dups.success) return err("donnees_invalides");

  // Dernière évaluation réussie de chaque idée (déjà triées par date décroissante).
  const latest = new Map<string, z.infer<typeof evaluationSchema>>();
  for (const e of evals.data) if (!latest.has(e.idea_id)) latest.set(e.idea_id, e);
  const scoresByIdea = new Map<string, z.infer<typeof scoreSchema>[]>();
  for (const s of scores.data) scoresByIdea.set(s.idea_id, [...(scoresByIdea.get(s.idea_id) ?? []), s]);

  const reportIdeas: ReportIdea[] = ideas.data.map(idea => {
    const evaluation = latest.get(idea.id) ?? null;
    const human = scoresByIdea.get(idea.id) ?? [];
    const perCriterion = criteria.data.map(criterion => {
      const h = human.find(s => s.criterion_id === criterion.id);
      const ai = evaluation?.criterion_assessments.find(a => a.criterion_id === criterion.id);
      return {
        criterion,
        score: h?.final_score ?? ai?.ai_score ?? null,
        validated: !!h,
        summary: ai?.summary ?? null,
        comment: h?.final_comment ?? null,
      };
    });
    return {
      idea,
      aiScore: evaluation?.synthesis?.note_globale_ia ?? null,
      validatedScore: weightedAverage(
        criteria.data.map(c => ({ weight: c.weight, score: human.find(s => s.criterion_id === c.id)?.final_score ?? null })),
      ),
      recommendation: evaluation?.recommendation ?? null,
      synthesis: evaluation?.synthesis ?? null,
      criteria: perCriterion,
      estimates: (evaluation?.estimates ?? []).map(e => ({ field: e.field, value: e.value })),
      webSources: evaluation?.web_sources_count ?? 0,
      evaluatedAt: evaluation?.created_at ?? null,
    };
  });

  return ok({
    challenge: challenge.data,
    criteria: criteria.data,
    ideas: reportIdeas,
    confirmedDuplicates: dups.data.map(d => [d.idea_a, d.idea_b] as [string, string]),
  });
}
