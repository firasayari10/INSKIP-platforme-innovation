import { describe, expect, test } from "bun:test";
import { agentRequestKey, canonicalJson, evaluationInputKey, sameModels, type AgentCallParams } from "@/domain/cache";
import {
  criterionMessages,
  jsonSchemaOf,
  criterionOutputSchema,
  synthesisMessages,
  synthesisOutputSchema,
  type CriterionForScoring,
  type CriterionOutput,
  type IdeaForScoring,
} from "@/domain/scoring";

describe("canonicalJson", () => {
  test("l'ordre des clés n'a aucun effet, à toutes les profondeurs", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
  });

  test("l'ordre des tableaux compte", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  test("ignore les propriétés undefined, comme JSON.stringify", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test("compare des modèles quel que soit l'ordre renvoyé par la base", () => {
    expect(sameModels({ associe: "x", analyste: "y", consultant: "z" }, { analyste: "y", consultant: "z", associe: "x" })).toBe(true);
    expect(sameModels({ associe: "x" }, { associe: "w" })).toBe(false);
    expect(sameModels(null, { associe: "x" })).toBe(false);
  });
});

// ---------- Clés de cache ----------

const idea: IdeaForScoring = {
  external_ref: "IDEA-001",
  title: "Capteurs de vibration",
  description: "Capteurs sur les compresseurs.",
  expected_benefits: "Moins d'arrêts",
  direction: "Maintenance",
  site: "Lyon",
  theme: "Énergie",
  budget_raw: "40 000 €",
  budget_eur: 40000,
};
const challenge = { client_name: "Hexavia", title: "C", context: null };
const impact: CriterionForScoring = { key: "impact", label: "Impact", description: "ROI", weight: 1, anchors: { "1": "faible", "5": "fort" } };
const params: AgentCallParams = { provider: "zai", model: "glm-5.2", temperature: 0.2, maxTokens: 4096, thinking: false, web: true, webCount: 5 };

const keyOfConsultant = (i: IdeaForScoring, c: CriterionForScoring, p = params) =>
  agentRequestKey(
    { schemaName: `consultant_${c.key}`, schema: jsonSchemaOf(criterionOutputSchema), messages: criterionMessages(c, i, challenge, null) },
    p,
  );

describe("agentRequestKey", () => {
  test("même demande, même clé", () => {
    expect(keyOfConsultant(idea, impact)).toBe(keyOfConsultant({ ...idea }, { ...impact }));
  });

  test.each([
    ["titre", { title: "Autre titre" }],
    ["budget", { budget_eur: 50000 }],
    ["thème", { theme: "Process" }],
    ["site", { site: "Metz" }],
  ])("un champ de l'idée modifié (%s) change la clé", (_label, change) => {
    expect(keyOfConsultant({ ...idea, ...change } as IdeaForScoring, impact)).not.toBe(keyOfConsultant(idea, impact));
  });

  test("la référence externe de l'idée n'entre pas dans la clé (doublons exacts réutilisables)", () => {
    expect(keyOfConsultant({ ...idea, external_ref: "IDEA-014" }, impact)).toBe(keyOfConsultant(idea, impact));
  });

  test("l'ancre d'un critère change la clé de son consultant", () => {
    expect(keyOfConsultant(idea, { ...impact, anchors: { "1": "nul", "5": "fort" } })).not.toBe(keyOfConsultant(idea, impact));
  });

  test("le poids d'un critère ne change pas la clé du consultant…", () => {
    expect(keyOfConsultant(idea, { ...impact, weight: 3 })).toBe(keyOfConsultant(idea, impact));
  });

  test("…mais change celle de l'associé", () => {
    const output = { note: 4, resume: "r", sous_criteres: [], arguments_pour: [], arguments_contre: [], hypotheses: [], donnees_manquantes: [], confiance: "moyenne", sources: [] } as unknown as CriterionOutput;
    const keyOfPartner = (weight: number) =>
      agentRequestKey(
        {
          schemaName: "associe",
          schema: jsonSchemaOf(synthesisOutputSchema),
          messages: synthesisMessages(idea, challenge, null, [{ criterion: { ...impact, weight }, output }], 4),
        },
        { ...params, web: false },
      );
    expect(keyOfPartner(3)).not.toBe(keyOfPartner(1));
  });

  test("le modèle, le fournisseur, la recherche web ou max_tokens changent la clé", () => {
    const base = keyOfConsultant(idea, impact);
    for (const p of [
      { ...params, model: "glm-5.3" },
      { ...params, provider: "openrouter" },
      { ...params, web: false },
      { ...params, maxTokens: 2048 },
    ]) {
      expect(keyOfConsultant(idea, impact, p)).not.toBe(base);
    }
  });
});

describe("evaluationInputKey", () => {
  const input = {
    idea,
    challenge,
    criteria: [impact],
    models: { analyste: "a", consultant: "c", associe: "s" },
    evaluatorNotes: null,
    promptVersion: "1.2",
    mode: "complete",
  };

  test("stable quel que soit l'ordre des clés des modèles", () => {
    expect(evaluationInputKey(input)).toBe(evaluationInputKey({ ...input, models: { associe: "s", consultant: "c", analyste: "a" } }));
  });

  test.each([
    ["contexte client", { challenge: { ...challenge, context: "Priorité RSE" } }],
    ["grille", { criteria: [{ ...impact, weight: 2 }] }],
    ["informations de l'évaluateur", { evaluatorNotes: "- budget réel 55 k€" }],
    ["version des consignes", { promptVersion: "1.3" }],
    ["modèle", { models: { analyste: "a", consultant: "c2", associe: "s" } }],
  ])("change si %s change (défaut D1)", (_label, change) => {
    expect(evaluationInputKey({ ...input, ...change })).not.toBe(evaluationInputKey(input));
  });
});
