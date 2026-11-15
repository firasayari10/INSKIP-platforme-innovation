import { describe, expect, test } from "bun:test";
import { rankIdeas, type RankCandidate } from "@/domain/shortlist";

const c = (ref: string, over: Partial<RankCandidate> = {}): RankCandidate => ({
  ideaId: `id-${ref}`,
  ref,
  aiScore: null,
  validatedScore: null,
  recommendation: null,
  ...over,
});

describe("rankIdeas", () => {
  test("classe par note décroissante et garde les N premières", () => {
    const r = rankIdeas([c("A", { aiScore: 3.1 }), c("B", { aiScore: 4.2 }), c("C", { aiScore: 3.8 })], [], 2);
    expect(r.selected.map(x => x.ref)).toEqual(["B", "C"]);
    expect(r.others.map(x => x.ref)).toEqual(["A"]);
    expect(r.selected.map(x => x.rank)).toEqual([1, 2]);
  });

  test("la note validée par l'évaluateur prime sur la proposition de l'IA", () => {
    const r = rankIdeas([c("A", { aiScore: 4.8, validatedScore: 3.0 }), c("B", { aiScore: 3.5 })], [], 2);
    expect(r.selected.map(x => [x.ref, x.score, x.scoreSource])).toEqual([
      ["B", 3.5, "ia"],
      ["A", 3.0, "validee"],
    ]);
  });

  test("égalité : note validée d'abord, puis recommandation, puis référence (ordre stable)", () => {
    const r = rankIdeas(
      [
        c("IDEA-010", { aiScore: 4 }),
        c("IDEA-002", { aiScore: 4 }),
        c("IDEA-005", { aiScore: 4, recommendation: "retenir" }),
        c("IDEA-001", { validatedScore: 4 }),
      ],
      [],
      4,
    );
    expect(r.selected.map(x => x.ref)).toEqual(["IDEA-001", "IDEA-005", "IDEA-002", "IDEA-010"]);
  });

  test("une idée non évaluée n'est jamais sélectionnée", () => {
    const r = rankIdeas([c("A"), c("B", { aiScore: 2 })], [], 8);
    expect(r.selected.map(x => x.ref)).toEqual(["B"]);
    expect(r.notEvaluated.map(x => x.ref)).toEqual(["A"]);
  });

  test("doublon confirmé : seule la mieux notée des deux est retenue, l'autre est signalée", () => {
    const r = rankIdeas(
      [c("IDEA-002", { aiScore: 4.1 }), c("IDEA-014", { aiScore: 4.0 }), c("IDEA-003", { aiScore: 3.0 })],
      [["id-IDEA-014", "id-IDEA-002"]],
      2,
    );
    expect(r.selected.map(x => x.ref)).toEqual(["IDEA-002", "IDEA-003"]);
    expect(r.duplicates).toEqual([{ ref: "IDEA-014", ideaId: "id-IDEA-014", duplicateOfRef: "IDEA-002" }]);
  });

  test("taille 0 ou liste vide", () => {
    expect(rankIdeas([], [], 8).selected).toEqual([]);
    expect(rankIdeas([c("A", { aiScore: 3 })], [], 0).selected).toEqual([]);
  });
});
