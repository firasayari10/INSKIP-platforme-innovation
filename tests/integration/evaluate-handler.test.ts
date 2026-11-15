import { describe, expect, test } from "bun:test";
import type { createClient } from "@supabase/supabase-js";
import { err, ok } from "@/domain/result";
import { PROMPT_VERSION } from "@/domain/scoring";
import { handleEvaluateIdea } from "@/server/evaluateHandler";
import type { AgentCaller } from "@/server/openrouter";

// ---------- Faux Supabase : enregistre qui lit/écrit quoi, avec quelle clé ----------

interface Op {
  key: string;
  table: string;
  kind: "select" | "insert" | "update";
  payload?: unknown;
  filters: [string, unknown][];
}

const IDEA_ID = "11111111-1111-4111-8111-111111111111";
const env = {
  OPENROUTER_API_KEY: "sk-or-test-0000",
  SUPABASE_URL: "https://projet.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test_000",
};
const models = {
  analyste: "anthropic/claude-haiku-5.5",
  consultant: "anthropic/claude-haiku-5.5",
  associe: "anthropic/claude-sonnet-5.5",
};

const ideaRow = {
  id: IDEA_ID,
  challenge_id: "22222222-2222-4222-8222-222222222222",
  external_ref: "IDEA-001",
  title: "Capteurs",
  description: "Capteurs de vibration.",
  expected_benefits: "Moins d'arrêts",
  direction: "Maintenance",
  site: "Lyon",
  theme: "Énergie",
  budget_raw: "40 000 €",
  budget_eur: "40000",
  content_hash: "a".repeat(64),
  challenges: { client_name: "Hexavia", title: "Challenge", context: "RSE" },
};
const criteriaRows = ["impact", "faisabilite"].map(key => ({
  id: `crit-${key}`,
  key,
  label: key,
  description: key,
  weight: "1",
  anchors: {},
}));

function fakeSupabase(opts: { user?: boolean; idea?: boolean; previous?: unknown[]; hourCount?: number } = {}) {
  const ops: Op[] = [];
  const data: Record<string, unknown> = {
    ideas: opts.idea === false ? null : ideaRow,
    criteria: criteriaRows,
    evaluations: opts.previous ?? [],
  };
  const make = ((_url: string, key: string) => {
    const builder = (table: string) => {
      const op: Op = { key, table, kind: "select", filters: [] };
      ops.push(op);
      const result = () => {
        if (op.kind === "insert" && table === "evaluations") return { data: { id: "eval-1" }, error: null };
        if (op.kind !== "select") return { data: null, error: null };
        if (op.filters.some(([c]) => c === "created_at>=")) return { data: null, count: opts.hourCount ?? 0, error: null };
        return { data: data[table], error: null };
      };
      const chain: Record<string, unknown> = {
        select: () => chain,
        insert: (payload: unknown) => ((op.kind = "insert"), (op.payload = payload), chain),
        update: (payload: unknown) => ((op.kind = "update"), (op.payload = payload), chain),
        eq: (col: string, v: unknown) => (op.filters.push([col, v]), chain),
        order: () => chain,
        limit: () => chain,
        lt: (col: string, v: unknown) => (op.filters.push([`${col}<`, v]), chain),
        gte: (col: string, v: unknown) => (op.filters.push([`${col}>=`, v]), chain),
        maybeSingle: async () => result(),
        single: async () => result(),
        then: (resolve: (v: unknown) => void) => resolve(result()),
      };
      return chain;
    };
    return {
      from: builder,
      auth: {
        getUser: async () =>
          opts.user === false ? { data: { user: null }, error: { message: "jwt" } } : { data: { user: { id: "user-1" } }, error: null },
      },
    };
  }) as unknown as typeof createClient;
  return { make, ops };
}

const assessment = (note: number) => ({
  note,
  resume: "Résumé.",
  sous_criteres: [
    { nom: "A", note, commentaire: "c" },
    { nom: "B", note, commentaire: "c" },
  ],
  arguments_pour: [],
  arguments_contre: [],
  hypotheses: [],
  donnees_manquantes: [],
  confiance: "moyenne",
  sources: [],
});
const synthesis = {
  synthese: "S.",
  points_forts: [],
  points_faibles: [],
  incoherences: [],
  recommandation: "retenir",
  justification_recommandation: "J.",
  prochaines_etapes: [],
};
const okCaller: AgentCaller = async r =>
  ok({
    json: r.schemaName === "associe" ? synthesis : assessment(4),
    citations: [],
    usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.001 },
    model: r.model,
  });

/** Récupère le travail d'arrière-plan pour pouvoir l'attendre dans le test. */
function backgroundCatcher() {
  const jobs: Promise<void>[] = [];
  return { background: (job: Promise<void>) => void jobs.push(job), settle: () => Promise.all(jobs) };
}

const post = (body: unknown, token: string | null = "jeton") =>
  new Request("http://localhost/api/evaluate-idea", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

describe("POST /api/evaluate-idea", () => {
  test("refuse une autre méthode que POST", async () => {
    const r = await handleEvaluateIdea(new Request("http://localhost/api/evaluate-idea"), env);
    expect(r.status).toBe(405);
  });

  test("503 si la configuration serveur est incomplète, sans révéler de valeur", async () => {
    const r = await handleEvaluateIdea(post({ ideaId: IDEA_ID }), { ...env, OPENROUTER_API_KEY: undefined });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "service_non_configure" });
  });

  test("401 sans jeton de session", async () => {
    const { make } = fakeSupabase();
    expect((await handleEvaluateIdea(post({ ideaId: IDEA_ID }, null), env, { createSupabase: make })).status).toBe(401);
  });

  test("401 si le jeton n'est pas valide", async () => {
    const { make } = fakeSupabase({ user: false });
    expect((await handleEvaluateIdea(post({ ideaId: IDEA_ID }), env, { createSupabase: make })).status).toBe(401);
  });

  test("400 sur une requête invalide", async () => {
    const { make } = fakeSupabase();
    expect((await handleEvaluateIdea(post({ ideaId: "pas-un-uuid" }), env, { createSupabase: make })).status).toBe(400);
  });

  test("404 si l'idée n'est pas accessible à l'utilisateur (RLS) — l'idée est lue avec SA clé, pas la clé serveur", async () => {
    const { make, ops } = fakeSupabase({ idea: false });
    const r = await handleEvaluateIdea(post({ ideaId: IDEA_ID }), env, { createSupabase: make, caller: okCaller });
    expect(r.status).toBe(404);
    expect(ops.find(o => o.table === "ideas")!.key).toBe(env.SUPABASE_PUBLISHABLE_KEY);
    expect(ops.some(o => o.kind !== "select")).toBe(false);
  });

  test("réutilise une évaluation identique déjà faite, sans appeler les agents", async () => {
    const { make } = fakeSupabase({
      previous: [{ id: "eval-old", status: "completed", created_at: new Date().toISOString(), models }],
    });
    let called = false;
    const r = await handleEvaluateIdea(post({ ideaId: IDEA_ID }), env, {
      createSupabase: make,
      caller: async x => ((called = true), okCaller(x)),
    });
    expect(await r.json()).toEqual({ evaluationId: "eval-old", cached: true, status: "completed" });
    expect(called).toBe(false);
  });

  test("si une évaluation est déjà en cours, renvoie la même sans en lancer une autre", async () => {
    const { make, ops } = fakeSupabase({ previous: [{ id: "e-en-cours", status: "running", created_at: new Date().toISOString(), models }] });
    const r = await handleEvaluateIdea(post({ ideaId: IDEA_ID }), env, { createSupabase: make, caller: okCaller });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ evaluationId: "e-en-cours", cached: false, status: "running" });
    expect(ops.some(o => o.kind === "insert")).toBe(false);
  });

  test("429 au-delà du quota d'évaluations par heure, sans appeler les agents", async () => {
    const { make, ops } = fakeSupabase({ hourCount: 60 });
    let called = false;
    const r = await handleEvaluateIdea(post({ ideaId: IDEA_ID }), env, {
      createSupabase: make,
      caller: async x => ((called = true), okCaller(x)),
    });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("600");
    expect(await r.json()).toEqual({ error: "trop_de_demandes" });
    expect(called).toBe(false);
    expect(ops.some(o => o.kind === "insert")).toBe(false);
    const quota = ops.find(o => o.filters.some(([c]) => c === "created_at>="))!;
    expect(quota.filters).toContainEqual(["requested_by", "user-1"]);
  });

  test("le quota se règle par variable d'environnement", async () => {
    const { make } = fakeSupabase({ hourCount: 5 });
    const r = await handleEvaluateIdea(post({ ideaId: IDEA_ID }), { ...env, EVALUATIONS_PER_HOUR: "5" }, { createSupabase: make, caller: okCaller });
    expect(r.status).toBe(429);
  });

  test("Z.ai est choisi automatiquement quand sa clé est fournie ; sans aucune clé, service non configuré", async () => {
    const { OPENROUTER_API_KEY: _o, ...withoutOpenRouter } = env;
    const { make } = fakeSupabase();
    expect((await handleEvaluateIdea(post({ ideaId: IDEA_ID }), withoutOpenRouter, { createSupabase: make })).status).toBe(503);
    const jobs = backgroundCatcher();
    const r = await handleEvaluateIdea(post({ ideaId: IDEA_ID }), { ...withoutOpenRouter, ZAI_API_KEY: "zai-test-key-0000" }, { createSupabase: make, caller: okCaller, ...jobs });
    expect(r.status).toBe(202);
    await jobs.settle();
  });

  test("répond aussitôt (202), évalue en arrière-plan, puis enregistre avec la clé serveur uniquement", async () => {
    const { make, ops } = fakeSupabase();
    const jobs = backgroundCatcher();
    const r = await handleEvaluateIdea(post({ ideaId: IDEA_ID }), env, { createSupabase: make, caller: okCaller, ...jobs });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ evaluationId: "eval-1", cached: false, status: "running" });
    await jobs.settle();
    const writes = ops.filter(o => o.kind !== "select");
    expect(writes.map(w => `${w.kind}:${w.table}`)).toEqual([
      "update:evaluations", // clôture des passages restés bloqués
      "insert:evaluations",
      "insert:criterion_assessments",
      "update:evaluations",
    ]);
    expect(writes.every(w => w.key === env.SUPABASE_SECRET_KEY)).toBe(true);
    expect(ops.some(o => o.table === "scores")).toBe(false); // la note humaine n'est jamais touchée
    expect(ops.some(o => o.table === "idea_authors")).toBe(false); // aucune donnée personnelle lue
    const created = writes[1]!.payload as Record<string, unknown>;
    expect(created).toMatchObject({ status: "running", prompt_version: PROMPT_VERSION, requested_by: "user-1" });
    const completed = writes[3]!.payload as Record<string, unknown>;
    expect(completed).toMatchObject({ status: "completed", recommendation: "retenir" });
  });

  test("clôt un passage resté bloqué au-delà du délai avant d'en lancer un nouveau", async () => {
    const { make, ops } = fakeSupabase();
    const jobs = backgroundCatcher();
    await handleEvaluateIdea(post({ ideaId: IDEA_ID }), env, { createSupabase: make, caller: okCaller, ...jobs });
    await jobs.settle();
    const close = ops.find(o => o.kind === "update" && o.table === "evaluations")!;
    expect(close.payload).toEqual({ status: "failed", error_code: "abandonnee" });
    expect(close.filters.map(([c]) => c)).toEqual(["idea_id", "status", "created_at<"]);
  });

  test("en cas d'échec d'un agent, l'évaluation est marquée en échec avec un code générique", async () => {
    const { make, ops } = fakeSupabase();
    const failing: AgentCaller = async () => err({ code: "credit_insuffisant", detail: "HTTP 402" });
    const jobs = backgroundCatcher();
    const r = await handleEvaluateIdea(post({ ideaId: IDEA_ID }), env, { createSupabase: make, caller: failing, ...jobs });
    expect(r.status).toBe(202); // l'échec est constaté en arrière-plan et enregistré
    await jobs.settle();
    expect(ops.at(-1)).toMatchObject({ kind: "update", table: "evaluations", payload: { status: "failed", error_code: "credit_insuffisant" } });
  });
});
