import { describe, expect, test } from "bun:test";
import { createRateLimiter } from "@/server/rateLimiter";
import { createZaiCaller, withSchemaInstruction } from "@/server/zai";
import type { AgentRequest } from "@/server/openrouter";

const request: AgentRequest = {
  model: "glm-5.2",
  messages: [
    { role: "system", content: "Tu es consultant." },
    { role: "user", content: "Évalue." },
  ],
  schemaName: "consultant_impact",
  schema: { type: "object", properties: { note: { type: "integer" } }, required: ["note"] },
  web: true,
};

function fakeFetch(responses: Response[]) {
  const sent: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") });
    const next = responses.shift();
    if (!next) throw new Error("plus de réponse prévue");
    return next;
  }) as typeof fetch;
  return { impl, sent };
}

const okResponse = (content: string, webSearch: unknown[] = []) =>
  new Response(
    JSON.stringify({
      model: "glm-5.2",
      choices: [{ message: { content } }],
      web_search: webSearch,
      usage: { prompt_tokens: 120, completion_tokens: 40 },
    }),
    { status: 200 },
  );

function setup(responses: Response[]) {
  const { impl, sent } = fakeFetch(responses);
  const pauses: number[] = [];
  const base = createRateLimiter({ maxConcurrent: 2, requestsPerMinute: 1000, minIntervalMs: 0 });
  const limiter = { run: base.run, pause: (ms: number) => void pauses.push(ms) };
  const call = createZaiCaller({
    apiKey: "zai-test-key",
    baseUrl: "https://api.z.ai/api/paas/v4/",
    webCount: 5,
    timeoutMs: 1000,
    thinking: false,
    limiter,
    fetchImpl: impl,
    sleep: async () => {},
    random: () => 0,
  });
  return { call, sent, pauses };
}

describe("client Z.ai (GLM)", () => {
  test("appelle le bon point d'entrée avec la clé, le mode JSON, la recherche web et la réflexion désactivée", async () => {
    const { call, sent } = setup([okResponse('{"note":4}')]);
    const r = await call(request);
    expect(r.ok).toBe(true);
    const s = sent[0]!;
    expect(s.url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    expect(s.auth).toBe("Bearer zai-test-key");
    expect(s.body.model).toBe("glm-5.2");
    expect(s.body.response_format).toEqual({ type: "json_object" });
    expect(s.body.thinking).toEqual({ type: "disabled" });
    expect(s.body.tools).toEqual([
      {
        type: "web_search",
        web_search: { enable: true, search_engine: "search_pro_jina", search_result: true, count: 5, content_size: "medium" },
      },
    ]);
  });

  test("décrit le schéma attendu dans les consignes système (pas de schéma imposé par l'API)", async () => {
    const { call, sent } = setup([okResponse('{"note":4}')]);
    await call(request);
    const messages = sent[0]!.body.messages as { role: string; content: string }[];
    expect(messages[0]!.content).toContain("Format de réponse OBLIGATOIRE");
    expect(messages[0]!.content).toContain('"note"');
    expect(messages[1]!.content).toBe("Évalue.");
  });

  test("sans recherche web, aucun outil n'est envoyé", async () => {
    const { call, sent } = setup([okResponse('{"note":4}')]);
    await call({ ...request, web: false });
    expect(sent[0]!.body.tools).toBeUndefined();
  });

  test("récupère les pages trouvées par la recherche web comme sources vérifiables", async () => {
    const { call } = setup([
      okResponse('```json\n{"note":4}\n```', [
        { title: "Étude maintenance", link: "https://exemple.fr/etude", content: "Résumé", media: "Exemple" },
        { title: "Sans lien" },
      ]),
    ]);
    expect(await call(request)).toMatchObject({
      ok: true,
      value: {
        json: { note: 4 },
        citations: [{ url: "https://exemple.fr/etude", title: "Étude maintenance", content: "Résumé" }],
        usage: { promptTokens: 120, completionTokens: 40 },
      },
    });
  });

  test("saturation (HTTP 429) : pause générale selon Retry-After, puis nouvelle tentative réussie", async () => {
    const { call, sent, pauses } = setup([
      new Response(JSON.stringify({ error: { code: "1302", message: "Rate limit" } }), { status: 429, headers: { "Retry-After": "7" } }),
      okResponse('{"note":3}'),
    ]);
    expect((await call(request)).ok).toBe(true);
    expect(sent).toHaveLength(2);
    expect(pauses).toEqual([7_000]);
  });

  test("surcharge signalée par un code Z.ai (1305) même avec un statut 200 inhabituel", async () => {
    const { call, sent } = setup([
      new Response(JSON.stringify({ error: { code: 1305, message: "overloaded" } }), { status: 400 }),
      okResponse('{"note":3}'),
    ]);
    expect((await call(request)).ok).toBe(true);
    expect(sent).toHaveLength(2);
  });

  test("crédit épuisé (code 1113) renvoyé avec un statut 429 : pas de nouvelle tentative, message de crédit", async () => {
    const { call, sent, pauses } = setup([
      new Response(JSON.stringify({ error: { code: "1113", message: "Insufficient balance or no resource package." } }), { status: 429 }),
    ]);
    expect(await call(request)).toMatchObject({ ok: false, error: { code: "credit_insuffisant" } });
    expect(sent).toHaveLength(1);
    expect(pauses).toEqual([]);
  });

  test("abandonne après plusieurs saturations successives", async () => {
    const saturated = () => new Response(JSON.stringify({ error: { code: "1302" } }), { status: 429 });
    const { call, sent } = setup([saturated(), saturated(), saturated(), saturated(), saturated()]);
    expect(await call(request)).toMatchObject({ ok: false, error: { code: "quota_depasse" } });
    expect(sent).toHaveLength(5);
  });

  test.each([
    [401, {}, "cle_invalide"],
    [400, { error: { code: "1113", message: "Insufficient balance" } }, "credit_insuffisant"],
    [400, { error: { code: "1211", message: "Model not found" } }, "modele_indisponible"],
    [400, { error: { code: "1210", message: "Bad parameter" } }, "reponse_invalide"],
  ])("HTTP %p %p → %p, sans nouvelle tentative", async (status, body, code) => {
    const { call, sent } = setup([new Response(JSON.stringify(body), { status })]);
    expect(await call(request)).toMatchObject({ ok: false, error: { code } });
    expect(sent).toHaveLength(1);
  });

  test("contenu non JSON : réponse invalide", async () => {
    const { call } = setup([okResponse("Voici mon analyse.")]);
    expect(await call(request)).toMatchObject({ ok: false, error: { code: "reponse_invalide" } });
  });

  test("withSchemaInstruction n'ajoute la consigne qu'au message système", () => {
    const out = withSchemaInstruction([{ role: "user", content: "x" }], { type: "object" });
    expect(out).toEqual([{ role: "user", content: "x" }]);
  });
});
