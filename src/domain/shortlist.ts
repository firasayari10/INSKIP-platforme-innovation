/**
 * Shortlist pour le jury : classement des idées évaluées et sélection des N meilleures.
 * Règles (CLAUDE.md §5) :
 * - note utilisée = note VALIDÉE par l'évaluateur (tous critères validés), sinon proposition de l'IA ;
 * - départage stable : note validée avant proposition IA, puis recommandation (retenir, à
 *   discuter, écarter), puis référence ;
 * - une idée confirmée comme doublon d'une idée mieux classée n'est pas retenue ;
 * - une idée non évaluée n'est jamais sélectionnée.
 */

export type Recommendation = "retenir" | "a_discuter" | "ecarter";

export interface RankCandidate {
  ideaId: string;
  ref: string;
  aiScore: number | null;
  validatedScore: number | null;
  recommendation: Recommendation | null;
}

export interface RankedIdea extends RankCandidate {
  rank: number;
  score: number;
  scoreSource: "validee" | "ia";
}

export interface Ranking {
  selected: RankedIdea[];
  others: RankedIdea[];
  notEvaluated: RankCandidate[];
  duplicates: { ref: string; ideaId: string; duplicateOfRef: string }[];
}

const RECO_ORDER: Record<string, number> = { retenir: 0, a_discuter: 1, ecarter: 2 };
const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

export function rankIdeas(
  candidates: readonly RankCandidate[],
  confirmedDuplicatePairs: readonly (readonly [string, string])[],
  size: number,
): Ranking {
  const scored = candidates
    .filter(c => c.validatedScore !== null || c.aiScore !== null)
    .map(c => ({
      ...c,
      score: (c.validatedScore ?? c.aiScore)!,
      scoreSource: (c.validatedScore !== null ? "validee" : "ia") as RankedIdea["scoreSource"],
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.scoreSource === b.scoreSource ? 0 : a.scoreSource === "validee" ? -1 : 1) ||
        (RECO_ORDER[a.recommendation ?? ""] ?? 3) - (RECO_ORDER[b.recommendation ?? ""] ?? 3) ||
        collator.compare(a.ref, b.ref),
    );

  // Doublons confirmés : on garde la première rencontrée (la mieux classée) de chaque paire.
  const partner = new Map<string, string[]>();
  for (const [a, b] of confirmedDuplicatePairs) {
    partner.set(a, [...(partner.get(a) ?? []), b]);
    partner.set(b, [...(partner.get(b) ?? []), a]);
  }
  const kept: typeof scored = [];
  const duplicates: Ranking["duplicates"] = [];
  const keptIds = new Set<string>();
  for (const idea of scored) {
    const better = (partner.get(idea.ideaId) ?? []).find(id => keptIds.has(id));
    if (better) {
      duplicates.push({ ref: idea.ref, ideaId: idea.ideaId, duplicateOfRef: scored.find(s => s.ideaId === better)!.ref });
      continue;
    }
    kept.push(idea);
    keptIds.add(idea.ideaId);
  }

  const ranked: RankedIdea[] = kept.map((idea, i) => ({ ...idea, rank: i + 1 }));
  const n = Math.max(0, size);
  return {
    selected: ranked.slice(0, n),
    others: ranked.slice(n),
    notEvaluated: candidates.filter(c => c.validatedScore === null && c.aiScore === null),
    duplicates,
  };
}
