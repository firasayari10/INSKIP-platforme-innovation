import { describe, expect, test } from "bun:test";
import { findDuplicateCandidates, similarityMatrix, type ComparableIdea } from "@/domain/similarity";
import { contentKey, normalizeText, significantTokens } from "@/domain/text";

const idea = (ref: string, title: string, description: string): ComparableIdea => ({ ref, title, description });

// Petit corpus : les poids TF-IDF ont besoin d'un contexte de plusieurs idées.
const corpus: ComparableIdea[] = [
  idea("A", "Chatbot RH", "Un robot qui répond aux questions des salariés sur la paie et les congés."),
  idea(
    "B",
    "Assistant IA pour les questions RH",
    "Un assistant conversationnel qui répond aux questions courantes des salariés : congés, mutuelle, paie.",
  ),
  idea("C", "Ombrières solaires sur les parkings", "Installer des panneaux photovoltaïques au-dessus des places de parking."),
  idea("D", "Tri des déchets métalliques", "Mettre en place des bennes séparées pour les chutes d'acier et d'aluminium."),
  idea("E", "Kanban digital", "Remplacer les cartes kanban papier par des écrans en atelier."),
];

describe("normalisation du texte", () => {
  test("ignore casse, accents et ponctuation", () => {
    expect(normalizeText("  Énergie : RÉCUPÉRATION, d'été ! ")).toBe("energie recuperation d ete");
  });

  test("retire les mots vides et rapproche singulier et pluriel", () => {
    expect(significantTokens("Les capteurs sur le compresseur")).toEqual(["capteur", "compresseur"]);
  });

  test("la clé de contenu ne dépend pas de la mise en forme", () => {
    expect(contentKey("Café gratuit", "Rendre le café gratuit.")).toBe(contentKey("CAFE  gratuit", "rendre le cafe gratuit"));
  });
});

describe("similarityMatrix", () => {
  const sim = similarityMatrix(corpus);

  test("une idée est identique à elle-même", () => {
    expect(sim(0, 0)).toBe(1);
  });

  test("la similarité est symétrique", () => {
    for (let i = 0; i < corpus.length; i++) for (let j = 0; j < corpus.length; j++) expect(sim(i, j)).toBe(sim(j, i));
  });

  test("reste comprise entre 0 et 1", () => {
    for (let i = 0; i < corpus.length; i++)
      for (let j = 0; j < corpus.length; j++) {
        expect(sim(i, j)).toBeGreaterThanOrEqual(0);
        expect(sim(i, j)).toBeLessThanOrEqual(1);
      }
  });

  test("deux reformulations de la même idée sont plus proches que deux idées sans rapport", () => {
    expect(sim(0, 1)).toBeGreaterThan(sim(2, 3));
  });

  test("un texte vide n'est proche de rien", () => {
    const s = similarityMatrix([...corpus, idea("Z", "", "")]);
    expect(s(0, corpus.length)).toBe(0);
  });
});

describe("findDuplicateCandidates", () => {
  test("détecte une reformulation", () => {
    const pairs = findDuplicateCandidates(corpus);
    expect(pairs).toContainEqual(expect.objectContaining({ refA: "A", refB: "B", kind: "similar" }));
  });

  test("ne rapproche pas des idées sans rapport", () => {
    const pairs = findDuplicateCandidates(corpus);
    expect(pairs.some(p => p.refA === "C" || p.refB === "C")).toBe(false);
  });

  test("un contenu identique est un doublon exact, même avec une mise en forme différente", () => {
    const pairs = findDuplicateCandidates([
      ...corpus,
      idea("F", "kanban DIGITAL", "Remplacer les cartes Kanban papier par des écrans en atelier"),
    ]);
    expect(pairs[0]).toEqual({ refA: "E", refB: "F", kind: "exact", similarity: 1 });
  });

  test("les références de chaque paire sont ordonnées et le résultat est stable", () => {
    const reversed = [...corpus].reverse();
    expect(findDuplicateCandidates(reversed)).toEqual(findDuplicateCandidates(corpus));
    for (const p of findDuplicateCandidates(corpus)) expect(p.refA < p.refB).toBe(true);
  });

  test("deux textes vides ne sont pas signalés comme doublons", () => {
    expect(findDuplicateCandidates([idea("X", "", ""), idea("Y", "", "")])).toEqual([]);
  });
});
