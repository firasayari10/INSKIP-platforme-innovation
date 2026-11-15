import { Redis } from "@upstash/redis";
import { createGate, createMemoryGateStore, createResilientGateStore, createUpstashGateStore, type Gate, type GateStore } from "./gate";
import { createMemoryUserRateLimiter, createUpstashUserRateLimiter, type UserRateLimiter } from "./userRateLimit";

/**
 * Choix des composants de limitation selon la configuration (ADR 0003 §2.4) :
 * - Upstash configuré → compteurs partagés entre instances, repli mémoire prudent si Redis tombe ;
 * - sinon (local) → mémoire ;
 * - production sans Upstash et sans RATE_LIMIT_BACKEND=memory explicite → configuration refusée.
 * Les instances sont partagées par processus (créées à la première requête).
 */

export interface InfraEnv {
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  RATE_LIMIT_BACKEND?: "redis" | "memory";
  VERCEL_ENV?: string;
  LLM_MAX_CONCURRENT: number;
  LLM_REQUESTS_PER_MINUTE: number;
  LLM_TIMEOUT_MS: number;
  LLM_FALLBACK_MAX_CONCURRENT: number;
  API_REQUESTS_PER_MINUTE_PER_USER: number;
}

const realClock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)) };

const useRedis = (env: InfraEnv) =>
  env.RATE_LIMIT_BACKEND !== "memory" && !!env.UPSTASH_REDIS_REST_URL && !!env.UPSTASH_REDIS_REST_TOKEN;

/** Vrai si la production démarrerait sans limitation partagée (erreur de configuration). */
export function rateLimitMisconfigured(env: InfraEnv): boolean {
  return env.VERCEL_ENV === "production" && !useRedis(env) && env.RATE_LIMIT_BACKEND !== "memory";
}

let redisClient: { key: string; redis: Redis } | null = null;
function redisFor(env: InfraEnv): Redis {
  const key = env.UPSTASH_REDIS_REST_URL!;
  if (redisClient?.key !== key) {
    redisClient = { key, redis: new Redis({ url: env.UPSTASH_REDIS_REST_URL!, token: env.UPSTASH_REDIS_REST_TOKEN! }) };
  }
  return redisClient.redis;
}

let gate: { key: string; gate: Gate } | null = null;
export function gateFor(env: InfraEnv): Gate {
  const key = [useRedis(env), env.LLM_MAX_CONCURRENT, env.LLM_REQUESTS_PER_MINUTE, env.LLM_TIMEOUT_MS, env.LLM_FALLBACK_MAX_CONCURRENT].join("/");
  if (gate?.key !== key) {
    let store: GateStore = createMemoryGateStore();
    if (useRedis(env)) {
      // Upstash garde les compteurs partagés ; la mémoire prend le relais si Redis ne répond pas.
      store = createResilientGateStore(
        createUpstashGateStore(redisFor(env)),
        createMemoryGateStore(),
        { timeoutMs: 300, retryAfterMs: 30_000, fallbackMaxConcurrent: env.LLM_FALLBACK_MAX_CONCURRENT, fallbackRateDivisor: 4 },
        realClock,
      );
    }
    gate = {
      key,
      gate: createGate(
        store,
        {
          maxConcurrent: env.LLM_MAX_CONCURRENT,
          requestsPerMinute: env.LLM_REQUESTS_PER_MINUTE,
          leaseMs: env.LLM_TIMEOUT_MS + 30_000, // une instance arrêtée ne bloque pas au-delà
          maxWaitMs: 10 * 60 * 1000,
          circuitThreshold: 5,
          circuitOpenMs: 2 * 60 * 1000,
        },
        realClock,
      ),
    };
  }
  return gate.gate;
}

let userLimiter: { key: string; limiter: UserRateLimiter } | null = null;
export function userRateLimiterFor(env: InfraEnv): UserRateLimiter {
  const key = `${useRedis(env)}/${env.API_REQUESTS_PER_MINUTE_PER_USER}`;
  if (userLimiter?.key !== key) {
    userLimiter = {
      key,
      limiter: useRedis(env)
        ? createUpstashUserRateLimiter(redisFor(env), env.API_REQUESTS_PER_MINUTE_PER_USER)
        : createMemoryUserRateLimiter(env.API_REQUESTS_PER_MINUTE_PER_USER),
    };
  }
  return userLimiter.limiter;
}
