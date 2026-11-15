import type { Redis } from "@upstash/redis";
import type { Clock, RateLimiter } from "./rateLimiter";

/**
 * Passerelle vers le fournisseur d'IA (ADR 0003 §2) : concurrence, débit, pause sur saturation et
 * coupe-circuit, PARTAGÉS entre toutes les instances du serveur grâce à Redis (Upstash, REST),
 * avec un magasin en mémoire pour le local et le repli. Aucune donnée personnelle ni contenu
 * dans Redis : uniquement des compteurs et des horodatages sous des clés globales.
 */

// ---------- Magasin de compteurs (contrat commun) ----------

export interface GateStore {
  /** Prend un créneau de concurrence (bail expirant à `leaseUntil`) si moins de `max` sont pris. */
  tryAcquireSlot(leaseId: string, max: number, leaseUntil: number, now: number): Promise<boolean>;
  releaseSlot(leaseId: string): Promise<void>;
  /** Seau à jetons : 0 si un jeton est accordé, sinon le délai d'attente (ms) avant le prochain. */
  takeToken(perMinute: number, capacity: number, now: number): Promise<number>;
  getPauseUntil(): Promise<number>;
  /** Prolonge la pause générale (garde la plus lointaine). */
  extendPause(until: number, now: number): Promise<void>;
  getCircuitOpenUntil(): Promise<number>;
  /** Échec passager : au-delà de `threshold` échecs consécutifs, ouvre le circuit `openMs`. */
  recordFailure(threshold: number, openMs: number, now: number): Promise<void>;
  recordSuccess(): Promise<void>;
}

export function createMemoryGateStore(): GateStore {
  const slots = new Map<string, number>();
  let tokens: number | null = null;
  let tokensAt = 0;
  let pauseUntil = 0;
  let failures = 0;
  let openUntil = 0;
  return {
    async tryAcquireSlot(id, max, leaseUntil, now) {
      for (const [k, exp] of slots) if (exp <= now) slots.delete(k);
      if (slots.size >= max) return false;
      slots.set(id, leaseUntil);
      return true;
    },
    async releaseSlot(id) {
      slots.delete(id);
    },
    async takeToken(perMinute, capacity, now) {
      const rate = perMinute / 60_000;
      const current = tokens === null ? capacity : Math.min(capacity, tokens + (now - tokensAt) * rate);
      tokensAt = now;
      if (current >= 1) {
        tokens = current - 1;
        return 0;
      }
      tokens = current;
      return Math.ceil((1 - current) / rate);
    },
    async getPauseUntil() {
      return pauseUntil;
    },
    async extendPause(until) {
      pauseUntil = Math.max(pauseUntil, until);
    },
    async getCircuitOpenUntil() {
      return openUntil;
    },
    async recordFailure(threshold, openMs, now) {
      failures += 1;
      if (failures >= threshold) {
        openUntil = now + openMs;
        failures = 0;
      }
    },
    async recordSuccess() {
      failures = 0;
    },
  };
}

// Scripts Lua exécutés atomiquement par Redis (une seule instance à la fois sur une clé).
const SLOT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZCARD', key) < tonumber(ARGV[2]) then
  redis.call('ZADD', key, tonumber(ARGV[3]), ARGV[1])
  redis.call('PEXPIRE', key, math.max(tonumber(ARGV[3]) - now, 1000))
  return 1
end
return 0`;

const TOKEN_SCRIPT = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local d = redis.call('HMGET', key, 't', 'ts')
local t = tonumber(d[1]) or cap
local ts = tonumber(d[2]) or now
t = math.min(cap, t + (now - ts) * rate)
local wait = 0
if t >= 1 then t = t - 1 else wait = math.ceil((1 - t) / rate) end
redis.call('HSET', key, 't', tostring(t), 'ts', tostring(now))
redis.call('PEXPIRE', key, 600000)
return wait`;

const PAUSE_SCRIPT = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local untilMs = tonumber(ARGV[1])
if untilMs > cur then redis.call('SET', KEYS[1], tostring(untilMs), 'PX', math.max(untilMs - tonumber(ARGV[2]), 1)) end
return 1`;

const FAILURE_SCRIPT = `
local n = redis.call('HINCRBY', KEYS[1], 'failures', 1)
redis.call('PEXPIRE', KEYS[1], 3600000)
if n >= tonumber(ARGV[1]) then
  redis.call('HSET', KEYS[1], 'open_until', ARGV[3] + ARGV[2], 'failures', 0)
end
return n`;

export function createUpstashGateStore(redis: Redis, prefix = "llm"): GateStore {
  const k = {
    inflight: `${prefix}:inflight`,
    rate: `${prefix}:rate`,
    pause: `${prefix}:pause_until`,
    circuit: `${prefix}:circuit`,
  };
  return {
    async tryAcquireSlot(id, max, leaseUntil, now) {
      return Number(await redis.eval(SLOT_SCRIPT, [k.inflight], [id, max, leaseUntil, now])) === 1;
    },
    async releaseSlot(id) {
      await redis.zrem(k.inflight, id);
    },
    async takeToken(perMinute, capacity, now) {
      return Number(await redis.eval(TOKEN_SCRIPT, [k.rate], [perMinute / 60_000, capacity, now]));
    },
    async getPauseUntil() {
      return Number((await redis.get<string | number>(k.pause)) ?? 0);
    },
    async extendPause(until, now) {
      await redis.eval(PAUSE_SCRIPT, [k.pause], [until, now]);
    },
    async getCircuitOpenUntil() {
      return Number((await redis.hget<string | number>(k.circuit, "open_until")) ?? 0);
    },
    async recordFailure(threshold, openMs, now) {
      await redis.eval(FAILURE_SCRIPT, [k.circuit], [threshold, openMs, now]);
    },
    async recordSuccess() {
      await redis.hset(k.circuit, { failures: 0 });
    },
  };
}

// ---------- Repli : Redis indisponible → mémoire, avec des valeurs prudentes ----------

export interface ResilienceConfig {
  timeoutMs: number;
  retryAfterMs: number;
  fallbackMaxConcurrent: number;
  /** Diviseur du débit en repli (chaque instance ne connaît que son propre débit). */
  fallbackRateDivisor: number;
}

export function createResilientGateStore(
  primary: GateStore,
  fallback: GateStore,
  config: ResilienceConfig,
  clock: Clock,
  log: (message: string) => void = m => console.error(m),
): GateStore & { degraded(): boolean } {
  let downUntil = 0;
  let lastLog = -Infinity;

  const attempt = async <T>(run: (s: GateStore) => Promise<T>, degraded: (s: GateStore) => Promise<T>): Promise<T> => {
    if (clock.now() < downUntil) return degraded(fallback);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(primary),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("délai Redis dépassé")), config.timeoutMs);
        }),
      ]);
    } catch (e) {
      downUntil = clock.now() + config.retryAfterMs;
      if (clock.now() - lastLog >= 60_000) {
        lastLog = clock.now();
        // Jamais d'URL ni de jeton dans le journal.
        log(`[passerelle-ia] redis_indisponible : ${e instanceof Error ? e.message.slice(0, 80) : "erreur"} ; repli mémoire`);
      }
      return degraded(fallback);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    degraded: () => clock.now() < downUntil,
    tryAcquireSlot: (id, max, until, now) =>
      attempt(s => s.tryAcquireSlot(id, max, until, now), s => s.tryAcquireSlot(id, Math.min(max, config.fallbackMaxConcurrent), until, now)),
    releaseSlot: id =>
      attempt(
        async s => {
          await s.releaseSlot(id);
          await fallback.releaseSlot(id); // un bail pris en repli est libéré aussi
        },
        s => s.releaseSlot(id),
      ),
    takeToken: (perMinute, capacity, now) =>
      attempt(
        s => s.takeToken(perMinute, capacity, now),
        s => s.takeToken(Math.max(1, Math.ceil(perMinute / config.fallbackRateDivisor)), 1, now),
      ),
    getPauseUntil: () => attempt(s => s.getPauseUntil(), s => s.getPauseUntil()),
    extendPause: (until, now) => attempt(s => s.extendPause(until, now), s => s.extendPause(until, now)),
    getCircuitOpenUntil: () => attempt(s => s.getCircuitOpenUntil(), s => s.getCircuitOpenUntil()),
    recordFailure: (t, o, now) => attempt(s => s.recordFailure(t, o, now), s => s.recordFailure(t, o, now)),
    recordSuccess: () => attempt(s => s.recordSuccess(), s => s.recordSuccess()),
  };
}

// ---------- Passerelle (interface RateLimiter conservée pour les clients d'IA) ----------

export class GateError extends Error {
  constructor(readonly code: "circuit_ouvert" | "attente_depassee") {
    super(code);
    this.name = "GateError";
  }
}

export interface GateConfig {
  maxConcurrent: number;
  requestsPerMinute: number;
  /** Durée d'un bail de concurrence (une instance arrêtée ne bloque pas au-delà). */
  leaseMs: number;
  /** Attente maximale d'un créneau avant abandon. */
  maxWaitMs: number;
  circuitThreshold: number;
  circuitOpenMs: number;
}

export type GateOutcome = "succes" | "echec_passager";

export interface Gate extends RateLimiter {
  report(outcome: GateOutcome): Promise<void>;
}

const POLL_MS = 250;

export function createGate(store: GateStore, config: GateConfig, clock: Clock, newId: () => string = () => crypto.randomUUID()): Gate {
  const acquire = async (): Promise<string> => {
    const deadline = clock.now() + config.maxWaitMs;
    const leaseId = newId();
    let tokenTaken = false;
    for (;;) {
      const now = clock.now();
      if (now > deadline) throw new GateError("attente_depassee");
      if ((await store.getCircuitOpenUntil()) > now) throw new GateError("circuit_ouvert");
      const pause = await store.getPauseUntil();
      if (pause > now) {
        await clock.sleep(Math.min(pause - now, 5_000));
        continue;
      }
      if (!tokenTaken) {
        const wait = await store.takeToken(config.requestsPerMinute, Math.max(1, config.maxConcurrent), now);
        if (wait > 0) {
          await clock.sleep(Math.min(wait, 5_000));
          continue;
        }
        tokenTaken = true;
      }
      if (await store.tryAcquireSlot(leaseId, config.maxConcurrent, now + config.leaseMs, now)) return leaseId;
      await clock.sleep(POLL_MS);
    }
  };

  return {
    async run(task) {
      const lease = await acquire();
      try {
        return await task();
      } finally {
        await store.releaseSlot(lease);
      }
    },
    pause(ms) {
      void store.extendPause(clock.now() + ms, clock.now());
    },
    async report(outcome) {
      if (outcome === "succes") await store.recordSuccess();
      else await store.recordFailure(config.circuitThreshold, config.circuitOpenMs, clock.now());
    },
  };
}
