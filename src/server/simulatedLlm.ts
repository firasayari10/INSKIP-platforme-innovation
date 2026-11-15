import { ok } from "../domain/result";
import type { AgentCaller, AgentRequest } from "./openrouter";

/**
 * Fournisseur d'IA SIMULÉ (LLM_PROVIDER=simulation) : aucun appel réseau, aucun jeton consommé.
 * Réponses déterministes (dérivées du contenu de la demande) et conformes aux schémas attendus,
 * pour développer et démontrer l'application sans fournisseur réel. Les « jetons » renvoyés
 * sont une estimation (≈ 4 caractères par jeton) afin d'exercer le suivi de consommation.
 */

const SIMULATED_MODEL = "simulation";

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Note de 2 à 5, stable pour une même demande. */
const scoreFrom = (seed: number, offset: number) => 2 + ((seed >>> offset) % 4);
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

function criterionAnswer(seed: number, criterion: string) {
  const note = scoreFrom(seed, 3);
  return {
    note,
    resume: `[Simulation] Évaluation fictive du critère « ${criterion} » : réponse générée sans IA, pour tester l'application.`,
    sous_criteres: [
      { nom: "Premier sous-critère", note: scoreFrom(seed, 5), commentaire: "[Simulation] Commentaire fictif." },
      { nom: "Second sous-critère", note: scoreFrom(seed, 7), commentaire: "[Simulation] Commentaire fictif." },
    ],
    arguments_pour: ["[Simulation] Argument favorable fictif."],
    arguments_contre: ["[Simulation] Point de vigilance fictif."],
    hypotheses: ["[Simulation] Aucune analyse réelle n'a été faite."],
    donnees_manquantes: [],
    confiance: "faible",
    sources: [],
  };
}

function answerFor(request: AgentRequest, seed: number): unknown {
  const name = request.schemaName;
  if (name.startsWith("consultant_")) return criterionAnswer(seed, name.slice("consultant_".length));
  if (name === "analyste") {
    const asked = /Champs à estimer : ([^\n.]*)/.exec(request.messages.map(m => m.content).join("\n"))?.[1] ?? "";
    const fields = ["budget", "benefices_attendus", "theme", "direction", "site"].filter(f => asked.includes(`${f} (`));
    return {
      estimations: fields.map(champ => ({
        champ,
        valeur: champ === "budget" ? "20 000 à 60 000 € (simulation)" : "[Simulation] Valeur estimée fictive",
        fourchette_min_eur: champ === "budget" ? 20000 : null,
        fourchette_max_eur: champ === "budget" ? 60000 : null,
        methode: "[Simulation] Méthode fictive, sans recherche.",
        hypotheses: [],
        confiance: "faible",
        sources: [],
      })),
    };
  }
  if (name === "associe") {
    const recommandations = ["retenir", "a_discuter", "ecarter"] as const;
    return {
      synthese: "[Simulation] Synthèse fictive produite sans IA : utile pour tester le parcours, sans valeur d'analyse.",
      points_forts: ["[Simulation] Point fort fictif."],
      points_faibles: ["[Simulation] Point faible fictif."],
      incoherences: [],
      recommandation: recommandations[seed % 3],
      justification_recommandation: "[Simulation] Recommandation tirée au hasard de façon déterministe.",
      prochaines_etapes: ["[Simulation] Configurer un fournisseur d'IA réel pour une vraie analyse."],
    };
  }
  if (name === "conversation") {
    return {
      reponse:
        "[Simulation] Réponse fictive de l'associé senior : aucun modèle d'IA n'a été appelé. Le fournisseur réel s'active avec LLM_PROVIDER=zai ou openrouter.",
      informations_apportees: [],
      suggere_reevaluation: false,
    };
  }
  return {};
}

export function createSimulatedCaller(options: { delayMs?: number } = {}): AgentCaller {
  const delay = options.delayMs ?? 300;
  return async request => {
    const text = request.messages.map(m => m.content).join("\n");
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    const json = answerFor(request, hash(`${request.schemaName}\n${text}`));
    return ok({
      json,
      citations: [],
      usage: {
        promptTokens: estimateTokens(text),
        completionTokens: estimateTokens(JSON.stringify(json)),
        costUsd: 0,
      },
      model: SIMULATED_MODEL,
    });
  };
}
