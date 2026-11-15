import { contentKey, significantTokens } from "./text";

/**
 * Détection des doublons, V1 lexicale et déterministe (CLAUDE.md §5) :
 * - « exact » : même contenu à la casse, aux accents et à la ponctuation près ;
 * - « similar » : similarité cosinus TF-IDF sur les mots significatifs (titre compté deux fois,
 *   description, bénéfices), mots tronqués à 5 lettres pour rapprocher les variantes
 *   (« prédictive » / « prédire », « dictée » / « dictent »).
 * Limite connue : deux idées identiques formulées avec des mots différents ne sont pas reconnues.
 * On propose, l'humain décide : jamais de fusion automatique.
 */

export interface ComparableIdea {
  ref: string;
  title: string;
  description: string;
  expectedBenefits?: string | null;
}

export interface DuplicateCandidate {
  refA: string;
  refB: string;
  kind: "exact" | "similar";
  similarity: number; // 0..1, arrondi au millième
}

/** Seuil au-delà duquel deux idées sont proposées comme doublons potentiels. */
export const SIMILARITY_THRESHOLD = 0.28;
const PREFIX_LENGTH = 5;

type Vector = Map<string, number>;

function terms(idea: ComparableIdea): string[] {
  const text = `${idea.title} ${idea.title} ${idea.description} ${idea.expectedBenefits ?? ""}`;
  return significantTokens(text).map(t => t.slice(0, PREFIX_LENGTH));
}

function tfidfVectors(docs: string[][]): Vector[] {
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
  const n = docs.length;
  return docs.map(doc => {
    const v: Vector = new Map();
    for (const term of doc) v.set(term, (v.get(term) ?? 0) + 1);
    for (const [term, tf] of v) v.set(term, tf * (Math.log((n + 1) / ((df.get(term) ?? 0) + 1)) + 1));
    return v;
  });
}

function cosine(a: Vector, b: Vector): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [term, x] of a) {
    na += x * x;
    const y = b.get(term);
    if (y !== undefined) dot += x * y;
  }
  for (const y of b.values()) nb += y * y;
  if (na === 0 || nb === 0) return 0;
  return Math.min(1, dot / Math.sqrt(na * nb));
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Similarité entre toutes les paires d'un lot. Les poids TF-IDF dépendent du lot : un mot
 * présent dans presque toutes les idées (« salariés ») pèse peu.
 */
export function similarityMatrix(ideas: ComparableIdea[]): (i: number, j: number) => number {
  const vectors = tfidfVectors(ideas.map(terms));
  return (i, j) => {
    if (i === j) return 1;
    const a = vectors[i];
    const b = vectors[j];
    return a && b ? round(cosine(a, b)) : 0;
  };
}

/** Paires candidates, triées par similarité décroissante puis par références (ordre stable). */
export function findDuplicateCandidates(
  ideas: ComparableIdea[],
  threshold: number = SIMILARITY_THRESHOLD,
): DuplicateCandidate[] {
  const sim = similarityMatrix(ideas);
  const keys = ideas.map(i => contentKey(i.title, i.description));
  const pairs: DuplicateCandidate[] = [];

  for (let i = 0; i < ideas.length; i++) {
    for (let j = i + 1; j < ideas.length; j++) {
      const a = ideas[i]!;
      const b = ideas[j]!;
      const [refA, refB] = a.ref < b.ref ? [a.ref, b.ref] : [b.ref, a.ref];
      if (keys[i] === keys[j] && keys[i]!.trim().length > 0) {
        pairs.push({ refA, refB, kind: "exact", similarity: 1 });
        continue;
      }
      const s = sim(i, j);
      if (s >= threshold) pairs.push({ refA, refB, kind: "similar", similarity: s });
    }
  }

  return pairs.sort(
    (x, y) => y.similarity - x.similarity || x.refA.localeCompare(y.refA) || x.refB.localeCompare(y.refB),
  );
}
