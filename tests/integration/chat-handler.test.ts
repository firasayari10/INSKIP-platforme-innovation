import { describe, expect, test } from "bun:test";
import type { createClient } from "@supabase/supabase-js";
import { err, ok } from "@/domain/result";
import { handleIdeaChat } from "@/server/chatHandler";
import type { AgentCaller, AgentRequest } from "@/server/openrouter";

interface Op {
  key: string;
  table: string;
  kind: "select" | "insert" | "update";
  payload?: unknown;
  filters: [string, unknown][];
  head?: boolean;
}

const IDEA_ID = "11111111-1111-4111-8111-111111111111";
const CHALLENGE_ID = "22222222-2222-4222-8222-222222222222";
const env = {
  ZAI_API_KEY: "zai-test-key-0000",
  SUPABASE_URL: "https://projet.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test_000",
};

const idea = {
  id: IDEA_ID,
  challenge_id: CHALLENGE_ID,
  external_ref: "IDEA-001",
  title: "Capteurs",
  description: "Capteurs de vibration.",
  expected_benefits: null,
  direction: "Maintenance",
  site: "Lyon",
  theme: "Énergie",
  budget_raw: "40 000 €",
  budget_eur: "40000",
  challenges: { client_name: "Hexavia", title: "Challenge", context: null },
};
const other = { ...idea, id: "33333333-3333-4333-8333-333333333333", external_ref: "IDEA-007", title: "Maintenance prédictive" };

function fakeSupabase(opts: { idea?: boolean; hourCount?: number } = {}) {
  const ops: Op[] = [];
  const make = ((_url: string, key: string) => {
    const from = (table: string) => {
      const op: Op = { key, table, kind: "select", filters: [] };
      ops.push(op);
      const result = () => {
        if (op.head) return { data: null, count: opts.hourCount ?? 0, error: null };
        if (op.kind === "insert") {
          const rows = op.payload as Record<string, unknown>[];
          return { data: rows.map((r, i) => ({ id: `m${i}`, created_at: "2026-11-15T17:00:00Z", used_for_evaluation_id: null, ...r })), error: null };
        }
        if (table === "ideas") {
          const isMention = op.filters.some(([c]) => c === "external_ref in");
          if (isMention) return { data: [other], error: null };
          return { data: opts.idea === false ? null : idea, error: null };
        }
        if (table === "evaluations") return { data: null, error: null };
        if (table === "idea_chat_messages") return { data: [], error: null };
        return { data: null, error: null };
      };
      const chain: Record<string, unknown> = {
        select: (_c: string, o?: { head?: boolean }) => ((op.head = !!o?.head), chain),
        insert: (p: unknown) => ((op.kind = "insert"), (op.payload = p), chain),
        eq: (c: string, v: unknown) => (op.filters.push([c, v]), chain),
        neq: (c: string, v: unknown) => (op.filters.push([`${c} !=`, v]), chain),
        in: (c: string, v: unknown) => (op.filters.push([`${c} in`, v]), chain),
        gte: (c: string, v: unknown) => (op.filters.push([`${c}>=`, v]), chain),
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => result(),
        then: (resolve: (v: unknown) => void) => resolve(result()),
      };
      return chain;
    };
    return { from, auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) } };
  }) as unknown as typeof createClient;
  return { make, ops };
}

const reply = { reponse: "La note d'innovation est basse car la pratique est répandue.", informations_apportees: ["Budget réel 55 k€"], suggere_reevaluation: true };
function capturingCaller(json: unknown = reply) {
  const calls: AgentRequest[] = [];
  const caller: AgentCaller = async r => {
    calls.push(r);
    return ok({ json, citations: [], usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 }, model: "glm-5.2" });
  };
  return { caller, calls };
}

const post = (body: unknown, token: string | null = "jeton") =>
  new Request("http://localhost/api/idea-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

describe("POST /api/idea-chat", () => {
  test("401 sans session", async () => {
    const { make } = fakeSupabase();
    expect((await handleIdeaChat(post({ ideaId: IDEA_ID, message: "x" }, null), env, { createSupabase: make })).status).toBe(401);
  });

  test("400 sur un message vide ou trop long", async () => {
    const { make } = fakeSupabase();
    expect((await handleIdeaChat(post({ ideaId: IDEA_ID, message: "  " }), env, { createSupabase: make })).status).toBe(400);
    expect((await handleIdeaChat(post({ ideaId: IDEA_ID, message: "x".repeat(4001) }), env, { createSupabase: make })).status).toBe(400);
  });

  test("404 si l'idée n'est pas accessible, lue avec la clé de l'utilisateur", async () => {
    const { make, ops } = fakeSupabase({ idea: false });
    const r = await handleIdeaChat(post({ ideaId: IDEA_ID, message: "Pourquoi ?" }), env, { createSupabase: make });
    expect(r.status).toBe(404);
    expect(ops.find(o => o.table === "ideas")!.key).toBe(env.SUPABASE_PUBLISHABLE_KEY);
  });

  test("429 au-delà du quota de messages par heure, sans appeler l'IA", async () => {
    const { make } = fakeSupabase({ hourCount: 120 });
    const { caller, calls } = capturingCaller();
    const r = await handleIdeaChat(post({ ideaId: IDEA_ID, message: "Pourquoi ?" }), env, { createSupabase: make, caller });
    expect(r.status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  test("répond, résout les @mentions dans le même challenge avec les droits de l'utilisateur, et enregistre les deux messages côté serveur", async () => {
    const { make, ops } = fakeSupabase();
    const { caller, calls } = capturingCaller();
    const r = await handleIdeaChat(post({ ideaId: IDEA_ID, message: "Compare avec @IDEA-007 et @IDEA-999" }), env, {
      createSupabase: make,
      caller,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { messages: { role: string; content: string }[]; suggestReevaluation: boolean; unknownRefs: string[] };
    expect(body.messages.map(m => m.role)).toEqual(["user", "assistant"]);
    expect(body.suggestReevaluation).toBe(true);
    expect(body.unknownRefs).toEqual(["IDEA-999"]);

    const mention = ops.find(o => o.table === "ideas" && o.filters.some(([c]) => c === "external_ref in"))!;
    expect(mention.key).toBe(env.SUPABASE_PUBLISHABLE_KEY);
    expect(mention.filters).toContainEqual(["challenge_id", CHALLENGE_ID]);

    const insert = ops.find(o => o.kind === "insert")!;
    expect(insert.key).toBe(env.SUPABASE_SECRET_KEY);
    expect(insert.table).toBe("idea_chat_messages");
    const rows = insert.payload as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ role: "user", author_id: "user-1", referenced_refs: ["IDEA-007"] });
    expect(rows[1]).toMatchObject({ role: "assistant", author_id: null, model: "glm-5.2" });

    const sent = calls[0]!.messages.map(m => m.content).join("\n");
    expect(sent).toContain("### IDEA-007");
    expect(calls[0]!.web).toBe(false);
    expect(ops.some(o => o.table === "idea_authors")).toBe(false);
  });

  test("échec de l'IA : code d'erreur, rien n'est enregistré", async () => {
    const { make, ops } = fakeSupabase();
    const caller: AgentCaller = async () => err({ code: "quota_depasse", detail: "429" });
    const r = await handleIdeaChat(post({ ideaId: IDEA_ID, message: "Pourquoi ?" }), env, { createSupabase: make, caller });
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "quota_depasse" });
    expect(ops.some(o => o.kind === "insert")).toBe(false);
  });

  test("réponse hors format deux fois : rejetée, rien n'est enregistré", async () => {
    const { make, ops } = fakeSupabase();
    const { caller, calls } = capturingCaller({ texte: "pas le bon format" });
    const r = await handleIdeaChat(post({ ideaId: IDEA_ID, message: "Pourquoi ?" }), env, { createSupabase: make, caller });
    expect(r.status).toBe(502);
    expect(calls).toHaveLength(2);
    expect(ops.some(o => o.kind === "insert")).toBe(false);
  });
});
