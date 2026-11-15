import { describe, expect, test } from "bun:test";
import { createRateLimiter, retryDelayMs } from "@/server/rateLimiter";

/** Horloge simulée : le temps n'avance que quand le limiteur « dort ». */
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
      await Promise.resolve();
    },
    advance: (ms: number) => (now += ms),
    sleeps,
  };
}

describe("createRateLimiter", () => {
  test("ne dépasse jamais le nombre d'appels simultanés", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ maxConcurrent: 2, requestsPerMinute: 1000, minIntervalMs: 0 }, clock);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        limiter.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise(r => setTimeout(r, 2));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  test("respecte le nombre d'appels par minute en attendant la fenêtre suivante", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ maxConcurrent: 10, requestsPerMinute: 2, minIntervalMs: 0 }, clock);
    const starts: number[] = [];
    for (let i = 0; i < 3; i++) await limiter.run(async () => void starts.push(clock.now()));
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBe(0);
    expect(starts[2]).toBeGreaterThanOrEqual(60_000);
  });

  test("espace les appels d'un délai minimal", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ maxConcurrent: 10, requestsPerMinute: 1000, minIntervalMs: 500 }, clock);
    const starts: number[] = [];
    for (let i = 0; i < 3; i++) await limiter.run(async () => void starts.push(clock.now()));
    expect(starts).toEqual([0, 500, 1000]);
  });

  test("après une saturation signalée, tous les appels attendent la fin de la pause", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ maxConcurrent: 10, requestsPerMinute: 1000, minIntervalMs: 0 }, clock);
    limiter.pause(30_000);
    let startedAt = -1;
    await limiter.run(async () => void (startedAt = clock.now()));
    expect(startedAt).toBeGreaterThanOrEqual(30_000);
  });

  test("libère sa place même si l'appel échoue", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ maxConcurrent: 1, requestsPerMinute: 1000, minIntervalMs: 0 }, clock);
    await expect(limiter.run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    let ran = false;
    await limiter.run(async () => void (ran = true));
    expect(ran).toBe(true);
  });
});

describe("retryDelayMs", () => {
  test("respecte l'en-tête Retry-After du fournisseur (secondes)", () => {
    expect(retryDelayMs(0, "12", () => 0)).toBe(12_000);
  });

  test("sinon, attente exponentielle avec une part aléatoire, plafonnée", () => {
    expect(retryDelayMs(0, null, () => 0)).toBe(2_000);
    expect(retryDelayMs(1, null, () => 0)).toBe(4_000);
    expect(retryDelayMs(2, null, () => 0.5)).toBe(8_000 + 500);
    expect(retryDelayMs(10, null, () => 0)).toBe(60_000);
  });

  test("ignore un Retry-After absurde", () => {
    expect(retryDelayMs(0, "abc", () => 0)).toBe(2_000);
    expect(retryDelayMs(0, "99999", () => 0)).toBe(60_000);
  });
});
