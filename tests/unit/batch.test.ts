import { describe, expect, test } from "bun:test";
import { ideasToEvaluate, runWithConcurrency, type BatchProgress } from "@/domain/batch";

describe("ideasToEvaluate", () => {
  test("garde les idées jamais évaluées ou en échec, ignore celles terminées ou en cours", () => {
    const status = new Map([
      ["b", "completed"],
      ["c", "running"],
      ["d", "failed"],
    ] as const);
    expect(ideasToEvaluate(["a", "b", "c", "d"], status)).toEqual(["a", "d"]);
  });
});

describe("runWithConcurrency", () => {
  test("traite tout, sans dépasser le nombre d'appels simultanés", async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    const result = await runWithConcurrency(
      [1, 2, 3, 4, 5],
      2,
      async n => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 5));
        seen.push(n);
        active -= 1;
        return true;
      },
      () => {},
    );
    expect(peak).toBe(2);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(result).toEqual({ done: 5, failed: 0, total: 5 });
  });

  test("compte les échecs, y compris une exception, sans interrompre le lot", async () => {
    const progress: BatchProgress[] = [];
    const result = await runWithConcurrency(
      ["ok", "ko", "boom"],
      1,
      async x => {
        if (x === "boom") throw new Error("x");
        return x === "ok";
      },
      p => progress.push(p),
    );
    expect(result).toEqual({ done: 3, failed: 2, total: 3 });
    expect(progress.map(p => p.done)).toEqual([1, 2, 3]);
  });

  test("s'arrête de lancer de nouvelles idées quand on le demande", async () => {
    let stop = false;
    const result = await runWithConcurrency(
      [1, 2, 3, 4],
      1,
      async n => {
        if (n === 2) stop = true;
        return true;
      },
      () => {},
      () => stop,
    );
    expect(result.done).toBe(2);
  });

  test("lot vide : rien à faire", async () => {
    expect(await runWithConcurrency([], 2, async () => true, () => {})).toEqual({ done: 0, failed: 0, total: 0 });
  });
});
