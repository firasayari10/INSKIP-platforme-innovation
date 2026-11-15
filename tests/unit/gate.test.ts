import { describe, expect, test } from "bun:test";
import {
  createGate,
  createMemoryGateStore,
  createResilientGateStore,
  GateError,
  type GateConfig,
  type GateStore,
} from "@/server/gate";

/** Horloge simulée : le temps n'avance que lors des attentes. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      await Promise.resolve();
    },
    advance: (ms: number) => (now += ms),
  };
}

// ---------- Contrat commun des magasins (mémoire ici ; Upstash : scripts/check-redis-gate.ts) ----------

export function gateStoreContract(name: string, make: () => GateStore) {
  describe(`contrat GateStore : ${name}`, () => {
    test("sémaphore : respecte le maximum, libère, récupère un bail expiré", async () => {
      const s = make();
      expect(await s.tryAcquireSlot("a", 2, 10_000, 0)).toBe(true);
      expect(await s.tryAcquireSlot("b", 2, 10_000, 0)).toBe(true);
      expect(await s.tryAcquireSlot("c", 2, 10_000, 0)).toBe(false);
      await s.releaseSlot("a");
      expect(await s.tryAcquireSlot("c", 2, 10_000, 1)).toBe(true);
      // « b » et « c » expirent à 10 000 : un bail abandonné ne bloque pas au-delà.
      expect(await s.tryAcquireSlot("d", 2, 30_000, 10_001)).toBe(true);
    });

    test("seau à jetons : capacité initiale, puis attente proportionnelle au débit", async () => {
      const s = make();
      expect(await s.takeToken(60, 2, 0)).toBe(0); // 60/min = 1 jeton par seconde
      expect(await s.takeToken(60, 2, 0)).toBe(0);
      const wait = await s.takeToken(60, 2, 0);
      expect(wait).toBeGreaterThan(900);
      expect(wait).toBeLessThanOrEqual(1_000);
      expect(await s.takeToken(60, 2, 1_000)).toBe(0); // un jeton regagné
    });

    test("pause : garde l'échéance la plus lointaine", async () => {
      const s = make();
      await s.extendPause(5_000, 0);
      await s.extendPause(2_000, 0);
      expect(await s.getPauseUntil()).toBe(5_000);
    });

    test("coupe-circuit : s'ouvre au seuil d'échecs consécutifs, un succès remet le compteur à zéro", async () => {
      const s = make();
      await s.recordFailure(3, 60_000, 100);
      await s.recordFailure(3, 60_000, 100);
      await s.recordSuccess();
      await s.recordFailure(3, 60_000, 100);
      await s.recordFailure(3, 60_000, 100);
      expect(await s.getCircuitOpenUntil()).toBe(0);
      await s.recordFailure(3, 60_000, 100);
      expect(await s.getCircuitOpenUntil()).toBe(60_100);
    });
  });
}

gateStoreContract("mémoire", createMemoryGateStore);

// ---------- Passerelle ----------

const config: GateConfig = {
  maxConcurrent: 2,
  requestsPerMinute: 1_000,
  leaseMs: 60_000,
  maxWaitMs: 120_000,
  circuitThreshold: 3,
  circuitOpenMs: 120_000,
};

describe("createGate", () => {
  test("ne dépasse jamais le nombre d'appels simultanés (partagé via le magasin)", async () => {
    const store = createMemoryGateStore();
    // Deux « instances » de serveur partageant le même magasin et la même heure (horloge réelle).
    const realClock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)) };
    const a = createGate(store, config, realClock);
    const b = createGate(store, config, realClock);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 3));
      active -= 1;
    };
    await Promise.all([a.run(task), b.run(task), a.run(task), b.run(task)]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("une pause demandée par une instance retarde les appels de toutes les autres", async () => {
    const store = createMemoryGateStore();
    const clock = fakeClock();
    createGate(store, config, clock).pause(30_000);
    const start = clock.now();
    let startedAt = 0;
    await createGate(store, config, clock).run(async () => void (startedAt = clock.now()));
    expect(startedAt - start).toBeGreaterThanOrEqual(30_000);
  });

  test("coupe-circuit ouvert : refus immédiat, sans attendre", async () => {
    const store = createMemoryGateStore();
    const gate = createGate(store, config, fakeClock());
    for (let i = 0; i < 3; i++) await gate.report("echec_passager");
    await expect(gate.run(async () => "x")).rejects.toThrow(GateError);
    await expect(gate.run(async () => "x")).rejects.toMatchObject({ code: "circuit_ouvert" });
  });

  test("le circuit se referme de lui-même après sa durée d'ouverture", async () => {
    const store = createMemoryGateStore();
    const clock = fakeClock();
    const gate = createGate(store, config, clock);
    for (let i = 0; i < 3; i++) await gate.report("echec_passager");
    clock.advance(120_001);
    expect(await gate.run(async () => "ok")).toBe("ok");
  });

  test("attente trop longue d'un créneau : abandon explicite", async () => {
    const store = createMemoryGateStore();
    const clock = fakeClock();
    await store.tryAcquireSlot("occupe-1", 1, clock.now() + 10_000_000, clock.now());
    const gate = createGate(store, { ...config, maxConcurrent: 1, maxWaitMs: 5_000 }, clock);
    await expect(gate.run(async () => "x")).rejects.toMatchObject({ code: "attente_depassee" });
  });

  test("libère son créneau même si l'appel échoue", async () => {
    const store = createMemoryGateStore();
    const gate = createGate(store, { ...config, maxConcurrent: 1 }, fakeClock());
    await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await gate.run(async () => "ok")).toBe("ok");
  });
});

// ---------- Repli si Redis est indisponible ----------

function brokenStore(): GateStore & { calls: number } {
  const fail = async () => {
    broken.calls += 1;
    throw new Error("connexion refusée");
  };
  const broken = {
    calls: 0,
    tryAcquireSlot: fail,
    releaseSlot: fail,
    takeToken: fail,
    getPauseUntil: fail,
    extendPause: fail,
    getCircuitOpenUntil: fail,
    recordFailure: fail,
    recordSuccess: fail,
  } as unknown as GateStore & { calls: number };
  return broken;
}

const resilience = { timeoutMs: 300, retryAfterMs: 30_000, fallbackMaxConcurrent: 1, fallbackRateDivisor: 4 };

describe("createResilientGateStore", () => {
  test("Redis en panne : bascule en mémoire, limites prudentes, un seul journal par minute", async () => {
    const clock = fakeClock();
    const logs: string[] = [];
    const primary = brokenStore();
    const store = createResilientGateStore(primary, createMemoryGateStore(), resilience, clock, m => logs.push(m));
    expect(await store.tryAcquireSlot("a", 5, clock.now() + 1_000, clock.now())).toBe(true);
    // En repli, concurrence ramenée à 1.
    expect(await store.tryAcquireSlot("b", 5, clock.now() + 1_000, clock.now())).toBe(false);
    expect(store.degraded()).toBe(true);
    expect(primary.calls).toBe(1); // pas de nouvel essai Redis pendant 30 s
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toMatch(/upstash|https?:/i);
  });

  test("réessaie Redis après 30 s", async () => {
    const clock = fakeClock();
    const primary = brokenStore();
    const store = createResilientGateStore(primary, createMemoryGateStore(), resilience, clock, () => {});
    await store.getPauseUntil();
    clock.advance(30_001);
    await store.getPauseUntil();
    expect(primary.calls).toBe(2);
  });

  test("Redis trop lent (> 300 ms) : traité comme indisponible", async () => {
    const slow = createMemoryGateStore();
    const slowStore: GateStore = { ...slow, getPauseUntil: () => new Promise(r => setTimeout(() => r(0), 400)) };
    const clock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)) };
    const store = createResilientGateStore(slowStore, createMemoryGateStore(), { ...resilience, timeoutMs: 50 }, clock, () => {});
    expect(await store.getPauseUntil()).toBe(0);
    expect(store.degraded()).toBe(true);
  });

  test("Redis disponible : tout passe par Redis", async () => {
    const clock = fakeClock();
    const primary = createMemoryGateStore();
    const store = createResilientGateStore(primary, createMemoryGateStore(), resilience, clock, () => {});
    await store.extendPause(clock.now() + 5_000, clock.now());
    expect(await primary.getPauseUntil()).toBe(clock.now() + 5_000);
    expect(store.degraded()).toBe(false);
  });
});

describe("limite de rafales par utilisateur (mémoire)", () => {
  test("fenêtre glissante de 60 s, utilisateurs indépendants", async () => {
    const { createMemoryUserRateLimiter } = await import("@/server/userRateLimit");
    let now = 0;
    const limiter = createMemoryUserRateLimiter(2, () => now);
    expect((await limiter.check("a")).allowed).toBe(true);
    expect((await limiter.check("a")).allowed).toBe(true);
    const third = await limiter.check("a");
    expect(third).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect((await limiter.check("b")).allowed).toBe(true);
    now = 60_001;
    expect((await limiter.check("a")).allowed).toBe(true);
  });
});
