import { describe, expect, test } from "bun:test";
import { chatMessages, chatOutputSchema } from "@/domain/chat";
import { jsonSchemaOf, type CriterionForScoring, type IdeaForScoring } from "@/domain/scoring";
import { evaluateIdea } from "@/server/evaluateIdea";
import { createSimulatedCaller } from "@/server/simulatedLlm";

const idea: IdeaForScoring = {
  external_ref: "IDEA-007",
  title: "Maintenance prédictive des compresseurs",
  description: "Mettre des capteurs sur les compresseurs pour prévoir les pannes.",
  expected_benefits: null,
  direction: "Maintenance",
  site: "Metz",
  theme: null,
  budget_raw: null,
  budget_eur: null,
};
const criteria: CriterionForScoring[] = ["impact", "faisabilite", "alignement", "innovation"].map(key => ({
  key,
  label: key,
  description: key,
  weight: 1,
  anchors: {},
}));
const challenge = { client_name: "Hexavia", title: "Challenge", context: null };

describe("fournisseur d'IA simulé", () => {
  test("aucun appel réseau : une évaluation complète passe toute la chaîne de validation", async () => {
    const realFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (async () => {
      networkCalls += 1;
      throw new Error("réseau interdit en simulation");
    }) as unknown as typeof fetch;
    try {
      const r = await evaluateIdea(
        { idea, challenge, criteria, models: { analyste: "simulation", consultant: "simulation", associe: "simulation" } },
        createSimulatedCaller({ delayMs: 0 }),
      );
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      expect(r.value.assessments).toHaveLength(4);
      expect(r.value.estimates.map(e => e.field).sort()).toEqual(["benefices_attendus", "budget", "theme"]);
      expect(r.value.aiGlobalScore).not.toBeNull();
      expect(r.value.synthesis.synthese).toContain("[Simulation]");
      expect(r.value.usage.calls).toBe(6);
      expect(r.value.usage.promptTokens).toBeGreaterThan(0);
      expect(r.value.usage.costUsd).toBe(0);
      expect(networkCalls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("réponses déterministes : même demande, même résultat", async () => {
    const call = createSimulatedCaller({ delayMs: 0 });
    const input = { idea, challenge, criteria, models: { analyste: "s", consultant: "s", associe: "s" } };
    const a = await evaluateIdea(input, call);
    const b = await evaluateIdea(input, call);
    expect(a.ok && b.ok && a.value.aiGlobalScore === b.value.aiGlobalScore).toBe(true);
  });

  test("la discussion simulée respecte le format attendu", async () => {
    const r = await createSimulatedCaller({ delayMs: 0 })({
      model: "simulation",
      messages: chatMessages({ idea, challenge, evaluation: null, mentioned: [], history: [], question: "Pourquoi ?" }),
      schemaName: "conversation",
      schema: jsonSchemaOf(chatOutputSchema),
      web: false,
    });
    expect(r.ok && chatOutputSchema.safeParse(r.value.json).success).toBe(true);
  });
});
