import { describe, expect, test } from "bun:test";
import { err, ok } from "@/domain/result";
import type { CriterionForScoring, IdeaForScoring } from "@/domain/scoring";
import { evaluateIdea, type EvaluationInput } from "@/server/evaluateIdea";
import {
  createOpenRouterCaller,
  extractJson,
  strictSchema,
  type AgentCaller,
  type AgentRequest,
  type AgentResponse,
} from "@/server/openrouter";

// ---------- Données ----------

const idea: IdeaForScoring = {
  external_ref: "IDEA-007",
  title: "Maintenance prédictive des compresseurs",
  description: "Mettre des capteurs sur les compresseurs pour prévoir les pannes.",
  expected_benefits: "Moins de pannes",
  direction: "Maintenance",
  site: "Metz",
  theme: "Énergie",
  budget_raw: null,
  budget_eur: null,
};

const criteria: CriterionForScoring[] = ["impact", "faisabilite", "alignement", "innovation"].map((key, i) => ({
  key,
  label: key,
  description: `Critère ${key}`,
  weight: i === 0 ? 2 : 1,
  anchors: {},
}));

const input: EvaluationInput = {
  idea,
  challenge: { client_name: "Hexavia", title: "Challenge", context: null },
  criteria,
  models: { analyste: "m/analyste", consultant: "m/consultant", associe: "m/associe" },
};

const SOURCE = "https://exemple.fr/etude";
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
  sources: [
    { url: SOURCE, titre: "Étude", apport: "chiffres" },
    { url: "https://inventee.fr", titre: "Fausse", apport: "x" },
  ],
});
const synthesis = {
  synthese: "Synthèse.",
  points_forts: [],
  points_faibles: [],
  incoherences: [],
  recommandation: "a_discuter",
  justification_recommandation: "Justification.",
  prochaines_etapes: [],
};
const estimates = {
  estimations: [
    {
      champ: "budget",
      valeur: "40 000 à 80 000 €",
      fourchette_min_eur: 40000,
      fourchette_max_eur: 80000,
      methode: "Capteurs IoT et plateforme.",
      hypotheses: ["12 compresseurs"],
      confiance: "moyenne",
      sources: [{ url: SOURCE, titre: "Prix", apport: "coût unitaire" }],
    },
    // Champ non demandé : doit être ignoré.
    { champ: "theme", valeur: "Autre", fourchette_min_eur: null, fourchette_max_eur: null, methode: "m", hypotheses: [], confiance: "faible", sources: [] },
  ],
};

const response = (json: unknown, web: boolean): AgentResponse => ({
  json,
  citations: web ? [{ url: SOURCE, title: "Étude", content: null }] : [],
  usage: { promptTokens: 100, completionTokens: 50, costUsd: 0.001 },
  model: "m/reel",
});

/** IA simulée : répond selon l'agent appelé (nom du schéma). */
function fakeCaller(overrides: Partial<Record<string, (r: AgentRequest) => ReturnType<AgentCaller>>> = {}) {
  const calls: AgentRequest[] = [];
  const notes: Record<string, number> = { consultant_impact: 4, consultant_faisabilite: 2, consultant_alignement: 3, consultant_innovation: 5 };
  const caller: AgentCaller = async request => {
    calls.push(request);
    const override = overrides[request.schemaName];
    if (override) return override(request);
    if (request.schemaName === "analyste") return ok(response(estimates, request.web));
    if (request.schemaName === "associe") return ok(response(synthesis, request.web));
    return ok(response(assessment(notes[request.schemaName] ?? 3), request.web));
  };
  return { caller, calls };
}

// ---------- Orchestration ----------

describe("evaluateIdea", () => {
  test("enchaîne analyste, 4 consultants puis associé, et calcule la note globale pondérée", async () => {
    const { caller, calls } = fakeCaller();
    const r = await evaluateIdea(input, caller);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(calls.map(c => c.schemaName)[0]).toBe("analyste");
    expect(calls.at(-1)!.schemaName).toBe("associe");
    expect(calls).toHaveLength(6);
    // (4×2 + 2 + 3 + 5) / 5 = 3,6
    expect(r.value.aiGlobalScore).toBe(3.6);
    expect(r.value.synthesis.recommandation).toBe("a_discuter");
    expect(r.value.usage.calls).toBe(6);
  });

  test("les consultants et l'analyste font une recherche web, pas l'associé", async () => {
    const { caller, calls } = fakeCaller();
    await evaluateIdea(input, caller);
    expect(calls.filter(c => c.web).map(c => c.schemaName).sort()).toEqual([
      "analyste",
      "consultant_alignement",
      "consultant_faisabilite",
      "consultant_impact",
      "consultant_innovation",
    ]);
  });

  test("chaque agent reçoit le modèle prévu pour son rôle", async () => {
    const { caller, calls } = fakeCaller();
    await evaluateIdea(input, caller);
    expect(calls.find(c => c.schemaName === "analyste")!.model).toBe("m/analyste");
    expect(calls.find(c => c.schemaName === "consultant_impact")!.model).toBe("m/consultant");
    expect(calls.find(c => c.schemaName === "associe")!.model).toBe("m/associe");
  });

  test("ne garde que les estimations demandées et que les sources réellement trouvées", async () => {
    const { caller } = fakeCaller();
    const r = await evaluateIdea(input, caller);
    if (!r.ok) throw new Error("échec");
    expect(r.value.estimates.map(e => e.field)).toEqual(["budget"]);
    expect(r.value.estimates[0]).toMatchObject({ rangeMinEur: 40000, rangeMaxEur: 80000 });
    const impact = r.value.assessments.find(a => a.criterionKey === "impact")!;
    expect(impact.sources.map(s => s.url)).toEqual([SOURCE]);
    expect(impact.rejectedSources).toBe(1);
  });

  test("pas d'appel à l'analyste si aucune donnée ne manque", async () => {
    const { caller, calls } = fakeCaller();
    await evaluateIdea({ ...input, idea: { ...idea, budget_eur: 40000, budget_raw: "40 000 €" } }, caller);
    expect(calls.some(c => c.schemaName === "analyste")).toBe(false);
  });

  test("les estimations sont transmises aux consultants comme des estimations", async () => {
    const { caller, calls } = fakeCaller();
    await evaluateIdea(input, caller);
    const text = calls.find(c => c.schemaName === "consultant_impact")!.messages.map(m => m.content).join("\n");
    expect(text).toContain("<estimations_analyste>");
    expect(text).toContain("40 000 à 80 000 €");
  });

  test("redemande une fois si la réponse est hors schéma, puis réussit", async () => {
    let n = 0;
    const { caller, calls } = fakeCaller({
      consultant_impact: async r => ok(response(++n === 1 ? { ...assessment(4), note: 9 } : assessment(4), r.web)),
    });
    const result = await evaluateIdea(input, caller);
    expect(result.ok).toBe(true);
    const retries = calls.filter(c => c.schemaName === "consultant_impact");
    expect(retries).toHaveLength(2);
    expect(retries[1]!.messages.at(-1)!.content).toContain("ne respectait pas le format");
  });

  test("échoue proprement si la réponse reste hors schéma : aucune note inventée", async () => {
    const { caller } = fakeCaller({ consultant_innovation: async r => ok(response({ note: "excellent" }, r.web)) });
    expect(await evaluateIdea(input, caller)).toMatchObject({
      ok: false,
      error: { code: "reponse_invalide", agent: "consultant_innovation" },
    });
  });

  test("remonte l'erreur du fournisseur (crédit, quota…)", async () => {
    const { caller } = fakeCaller({ analyste: async () => err({ code: "credit_insuffisant", detail: "HTTP 402" }) });
    expect(await evaluateIdea(input, caller)).toMatchObject({ ok: false, error: { code: "credit_insuffisant", agent: "analyste" } });
  });

  test("refuse une grille vide", async () => {
    const { caller } = fakeCaller();
    expect(await evaluateIdea({ ...input, criteria: [] }, caller)).toMatchObject({ ok: false, error: { code: "aucun_critere" } });
  });
});

// ---------- Client OpenRouter ----------

function fakeFetch(responses: (Response | Error)[]) {
  const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    const next = responses.shift();
    if (!next) throw new Error("plus de réponse prévue");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { impl, requests };
}

const okBody = (content: string, annotations: unknown[] = []) =>
  new Response(
    JSON.stringify({
      model: "anthropic/claude-haiku-5.5",
      choices: [{ message: { content, annotations } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0002 },
    }),
    { status: 200 },
  );

const request: AgentRequest = {
  model: "anthropic/claude-haiku-5.5",
  messages: [{ role: "user", content: "x" }],
  schemaName: "consultant_impact",
  schema: { type: "object", properties: { a: { type: "object", properties: {} } } },
  web: true,
};
const config = { apiKey: "sk-or-test", webMaxResults: 5, timeoutMs: 1000, appUrl: "http://localhost:3000", sleep: async () => {} };

describe("client OpenRouter", () => {
  test("envoie la clé, le schéma strict, la recherche web et exclut les fournisseurs qui conservent les données", async () => {
    const { impl, requests } = fakeFetch([okBody('{"a":{}}')]);
    const r = await createOpenRouterCaller({ ...config, fetchImpl: impl })(request);
    expect(r.ok).toBe(true);
    const sent = requests[0]!;
    expect(sent.headers.get("authorization")).toBe("Bearer sk-or-test");
    expect(sent.body.plugins).toEqual([{ id: "web", max_results: 5 }]);
    expect(sent.body.provider).toEqual({ data_collection: "deny", require_parameters: true });
    expect(sent.body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
  });

  test("sans recherche web, aucun plugin n'est envoyé", async () => {
    const { impl, requests } = fakeFetch([okBody("{}")]);
    await createOpenRouterCaller({ ...config, fetchImpl: impl })({ ...request, web: false });
    expect(requests[0]!.body.plugins).toBeUndefined();
  });

  test("récupère les pages trouvées par la recherche et la consommation", async () => {
    const { impl } = fakeFetch([
      okBody('```json\n{"ok":true}\n```', [
        { type: "url_citation", url_citation: { url: "https://a.fr", title: "A", content: "extrait" } },
        { type: "autre" },
      ]),
    ]);
    const r = await createOpenRouterCaller({ ...config, fetchImpl: impl })(request);
    expect(r).toMatchObject({
      ok: true,
      value: { json: { ok: true }, citations: [{ url: "https://a.fr", title: "A", content: "extrait" }], usage: { costUsd: 0.0002 } },
    });
  });

  test("réessaie sur erreur passagère (429, 5xx) puis réussit", async () => {
    const { impl, requests } = fakeFetch([new Response("", { status: 429 }), new Response("", { status: 503 }), okBody("{}")]);
    expect((await createOpenRouterCaller({ ...config, fetchImpl: impl })(request)).ok).toBe(true);
    expect(requests).toHaveLength(3);
  });

  test("abandonne après les nouvelles tentatives", async () => {
    const { impl } = fakeFetch([new Response("", { status: 429 }), new Response("", { status: 429 }), new Response("", { status: 429 })]);
    expect(await createOpenRouterCaller({ ...config, fetchImpl: impl })(request)).toMatchObject({ ok: false, error: { code: "quota_depasse" } });
  });

  test.each([
    [401, "cle_invalide"],
    [402, "credit_insuffisant"],
    [404, "modele_indisponible"],
  ])("HTTP %p → %p, sans nouvelle tentative", async (status, code) => {
    const { impl, requests } = fakeFetch([new Response("{}", { status })]);
    expect(await createOpenRouterCaller({ ...config, fetchImpl: impl })(request)).toMatchObject({ ok: false, error: { code } });
    expect(requests).toHaveLength(1);
  });

  test("contenu non JSON : réponse invalide", async () => {
    const { impl } = fakeFetch([okBody("Voici mon analyse…")]);
    expect(await createOpenRouterCaller({ ...config, fetchImpl: impl })(request)).toMatchObject({ ok: false, error: { code: "reponse_invalide" } });
  });

  test("schéma strict : tout objet refuse les propriétés imprévues", () => {
    expect(strictSchema({ $schema: "x", type: "object", properties: { a: { type: "object" } } })).toEqual({
      type: "object",
      properties: { a: { type: "object", additionalProperties: false } },
      additionalProperties: false,
    });
  });

  test("extrait le JSON d'un bloc de code", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => extractJson("pas du json")).toThrow();
  });
});

// ---------- Cache par agent (ADR 0003 §1) ----------

import { createMemoryAgentCache } from "@/server/agentCache";

describe("cache par agent", () => {
  test("une seconde évaluation identique ne rappelle aucun agent", async () => {
    const cache = createMemoryAgentCache();
    const first = fakeCaller();
    await evaluateIdea(input, first.caller, { cache });
    expect(first.calls).toHaveLength(6);
    const second = fakeCaller();
    const r = await evaluateIdea(input, second.caller, { cache });
    expect(second.calls).toHaveLength(0);
    expect(r.ok && r.value.usage).toMatchObject({ calls: 0, cacheHits: 6 });
  });

  test("si l'associé échoue, la relance ne rappelle que lui (reprise partielle)", async () => {
    const cache = createMemoryAgentCache();
    const failing = fakeCaller({ associe: async () => err({ code: "quota_depasse", detail: "429" }) });
    expect((await evaluateIdea(input, failing.caller, { cache })).ok).toBe(false);
    const retry = fakeCaller();
    const r = await evaluateIdea(input, retry.caller, { cache });
    expect(r.ok).toBe(true);
    expect(retry.calls.map(c => c.schemaName)).toEqual(["associe"]);
  });

  test("un doublon exact (autre référence, même contenu) réutilise les analyses", async () => {
    const cache = createMemoryAgentCache();
    await evaluateIdea(input, fakeCaller().caller, { cache });
    const duplicate = fakeCaller();
    await evaluateIdea({ ...input, idea: { ...idea, external_ref: "IDEA-014" } }, duplicate.caller, { cache });
    expect(duplicate.calls).toHaveLength(0);
  });

  test("changer le poids d'un critère ne relance que l'associé", async () => {
    const cache = createMemoryAgentCache();
    await evaluateIdea(input, fakeCaller().caller, { cache });
    const reweighted = fakeCaller();
    const criteria2 = input.criteria.map(c => (c.key === "innovation" ? { ...c, weight: 3 } : c));
    await evaluateIdea({ ...input, criteria: criteria2 }, reweighted.caller, { cache });
    expect(reweighted.calls.map(c => c.schemaName)).toEqual(["associe"]);
  });

  test("modifier l'idée relance tous les agents", async () => {
    const cache = createMemoryAgentCache();
    await evaluateIdea(input, fakeCaller().caller, { cache });
    const changed = fakeCaller();
    await evaluateIdea({ ...input, idea: { ...idea, description: "Autre description." } }, changed.caller, { cache });
    expect(changed.calls).toHaveLength(6);
  });

  test("« Relancer l'évaluation » ne lit pas le cache", async () => {
    const cache = createMemoryAgentCache();
    await evaluateIdea(input, fakeCaller().caller, { cache });
    const forced = fakeCaller();
    await evaluateIdea(input, forced.caller, { cache, useCache: false });
    expect(forced.calls).toHaveLength(6);
  });

  test("une entrée de cache corrompue est ignorée et l'agent rappelé, jamais « réparée »", async () => {
    const cache = createMemoryAgentCache();
    await evaluateIdea(input, fakeCaller().caller, { cache });
    for (const e of cache.entries.values()) if (e.agent === "associe") e.output = { recommandation: "peut-etre" };
    const next = fakeCaller();
    const r = await evaluateIdea(input, next.caller, { cache });
    expect(r.ok).toBe(true);
    expect(next.calls.map(c => c.schemaName)).toEqual(["associe"]);
  });

  test("une réponse invalide n'est jamais mise en cache", async () => {
    const cache = createMemoryAgentCache();
    const bad = fakeCaller({ consultant_innovation: async r => ok(response({ note: "excellent" }, r.web)) });
    await evaluateIdea(input, bad.caller, { cache });
    expect([...cache.entries.values()].some(e => e.criterionKey === "innovation")).toBe(false);
  });
});
