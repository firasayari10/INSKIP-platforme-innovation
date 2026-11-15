import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { err, ok, type Result } from "@/domain/result";
import type { ImportPayload } from "@/domain/importAnalysis";

/**
 * Accès aux données. Toutes les requêtes passent par la RLS : un utilisateur ne voit que
 * les challenges dont il est membre. Les réponses sont validées par zod (entrée externe).
 * NB : à remplacer par les types générés depuis Supabase (src/types/database.ts) une fois
 * la migration appliquée.
 */

export type DataError =
  | "acces_refuse"
  | "introuvable"
  | "donnees_invalides"
  | "reseau"
  | "service_non_initialise"
  | "inconnue";

function toDataError(error: PostgrestError | null): DataError {
  if (!error) return "inconnue";
  // Table ou fonction absente : la migration n'a pas été appliquée sur ce projet.
  if (["PGRST205", "PGRST202", "42P01", "42883"].includes(error.code)) return "service_non_initialise";
  if (error.code === "42501" || error.code === "PGRST301") return "acces_refuse";
  if (error.code === "PGRST116") return "introuvable";
  // 22023 : lot invalide (RPC) · 23514/23502 : contrainte · 22P02/22007 : nombre ou date illisible
  if (["22023", "23514", "23502", "22P02", "22007"].includes(error.code)) return "donnees_invalides";
  if (!error.code && /fetch|network/i.test(error.message)) return "reseau";
  return "inconnue";
}

// ---------- Challenges ----------

const challengeSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  client_name: z.string(),
  jury_date: z.string().nullable(),
  created_at: z.string(),
  ideas: z.array(z.object({ count: z.number() })).optional(),
});
export type Challenge = z.infer<typeof challengeSchema> & { ideaCount: number };

const withCount = (c: z.infer<typeof challengeSchema>): Challenge => ({ ...c, ideaCount: c.ideas?.[0]?.count ?? 0 });

export async function listChallenges(client: SupabaseClient): Promise<Result<Challenge[], DataError>> {
  const { data, error } = await client
    .from("challenges")
    .select("id, title, client_name, jury_date, created_at, ideas(count)")
    .order("created_at", { ascending: false });
  if (error) return err(toDataError(error));
  const parsed = z.array(challengeSchema).safeParse(data);
  return parsed.success ? ok(parsed.data.map(withCount)) : err("donnees_invalides");
}

export async function getChallenge(client: SupabaseClient, id: string): Promise<Result<Challenge, DataError>> {
  if (!z.uuid().safeParse(id).success) return err("introuvable");
  const { data, error } = await client
    .from("challenges")
    .select("id, title, client_name, jury_date, created_at, ideas(count)")
    .eq("id", id)
    .single();
  if (error) return err(toDataError(error));
  const parsed = challengeSchema.safeParse(data);
  return parsed.success ? ok(withCount(parsed.data)) : err("donnees_invalides");
}

export const newChallengeSchema = z.object({
  title: z.string().trim().min(1, "Donnez un nom au challenge.").max(200, "200 caractères au maximum."),
  client_name: z.string().trim().min(1, "Indiquez le client.").max(200, "200 caractères au maximum."),
});

export async function createChallenge(
  client: SupabaseClient,
  input: z.infer<typeof newChallengeSchema>,
): Promise<Result<{ id: string }, DataError>> {
  const { data, error } = await client.from("challenges").insert(input).select("id").single();
  if (error) return err(toDataError(error));
  const parsed = z.object({ id: z.uuid() }).safeParse(data);
  return parsed.success ? ok(parsed.data) : err("donnees_invalides");
}

// ---------- Idées ----------

const ideaRowSchema = z.object({
  id: z.uuid(),
  external_ref: z.string(),
  title: z.string(),
  direction: z.string().nullable(),
  site: z.string().nullable(),
  theme: z.string().nullable(),
  budget_raw: z.string().nullable(),
  budget_eur: z.coerce.number().nullable(),
  submitted_at: z.string().nullable(),
  quality_flags: z.array(z.string()),
});
export type IdeaRow = z.infer<typeof ideaRowSchema>;

export async function listIdeas(client: SupabaseClient, challengeId: string): Promise<Result<IdeaRow[], DataError>> {
  const { data, error } = await client
    .from("ideas")
    .select("id, external_ref, title, direction, site, theme, budget_raw, budget_eur, submitted_at, quality_flags")
    .eq("challenge_id", challengeId)
    .order("external_ref");
  if (error) return err(toDataError(error));
  const parsed = z.array(ideaRowSchema).safeParse(data);
  return parsed.success ? ok(parsed.data) : err("donnees_invalides");
}

// ---------- Import ----------

const importResultSchema = z.object({
  batch_id: z.uuid(),
  inserted: z.number(),
  updated: z.number(),
  duplicates_added: z.number(),
});
export type ImportResult = z.infer<typeof importResultSchema>;

/** Enregistrement atomique d'un lot (fonction `import_ideas` : tout ou rien). */
export async function importIdeas(
  client: SupabaseClient,
  challengeId: string,
  fileName: string,
  payload: ImportPayload,
): Promise<Result<ImportResult, DataError>> {
  const { data, error } = await client.rpc("import_ideas", {
    p_challenge_id: challengeId,
    p_file_name: fileName.slice(0, 255),
    p_ideas: payload.ideas,
    p_duplicates: payload.duplicates,
    p_report: payload.report,
  });
  if (error) return err(toDataError(error));
  const parsed = importResultSchema.safeParse(data);
  return parsed.success ? ok(parsed.data) : err("donnees_invalides");
}
