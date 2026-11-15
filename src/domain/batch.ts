/** Notation par lot : choix des idées à évaluer et exécution avec un nombre d'appels simultanés borné. */

export type EvaluationStatus = "running" | "completed" | "failed";

/** Idées sans évaluation réussie ni en cours, dans l'ordre de la liste. */
export function ideasToEvaluate(ideaIds: readonly string[], statusByIdea: ReadonlyMap<string, EvaluationStatus>): string[] {
  return ideaIds.filter(id => {
    const status = statusByIdea.get(id);
    return status !== "completed" && status !== "running";
  });
}

export interface BatchProgress {
  done: number;
  failed: number;
  total: number;
}

/**
 * Exécute `worker` sur chaque élément, au plus `limit` à la fois. S'arrête de lancer de nouveaux
 * éléments dès que `shouldStop()` renvoie vrai (les éléments en cours vont à leur terme).
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<boolean>,
  onProgress: (p: BatchProgress) => void,
  shouldStop: () => boolean = () => false,
): Promise<BatchProgress> {
  const progress: BatchProgress = { done: 0, failed: 0, total: items.length };
  let next = 0;
  const lane = async () => {
    while (next < items.length && !shouldStop()) {
      const item = items[next++]!;
      let success = false;
      try {
        success = await worker(item);
      } catch {
        success = false;
      }
      progress.done += 1;
      if (!success) progress.failed += 1;
      onProgress({ ...progress });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return progress;
}
