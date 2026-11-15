import { Ratelimit } from "@upstash/ratelimit";
import type { Redis } from "@upstash/redis";
import { sha256Hex } from "../lib/hash";

/**
 * Limite les rafales de requêtes par utilisateur sur l'API (ADR 0003 §2) : fenêtre glissante.
 * FAIL-OPEN : si Redis est indisponible, la requête passe (les quotas horaires en base et les
 * crédits IA restent actifs). L'identifiant envoyé à Redis est une empreinte tronquée, jamais
 * l'identifiant de l'utilisateur.
 */

export interface UserRateLimiter {
  check(userId: string): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

const userKey = async (userId: string) => (await sha256Hex(`utilisateur:${userId}`)).slice(0, 32);

export function createUpstashUserRateLimiter(redis: Redis, perMinute: number, timeoutMs = 300): UserRateLimiter {
  const ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(perMinute, "60 s"),
    prefix: "rl:u",
    analytics: false, // pas d'identifiants dans les statistiques Upstash
    timeout: timeoutMs, // au-delà : la requête passe (fail-open)
  });
  return {
    async check(userId) {
      try {
        const r = await ratelimit.limit(await userKey(userId));
        return { allowed: r.success, retryAfterSeconds: Math.max(1, Math.ceil((r.reset - Date.now()) / 1000)) };
      } catch {
        return { allowed: true, retryAfterSeconds: 0 };
      }
    },
  };
}

/** Fenêtre glissante en mémoire (local, ou en l'absence de Redis). */
export function createMemoryUserRateLimiter(perMinute: number, now: () => number = Date.now): UserRateLimiter {
  const hits = new Map<string, number[]>();
  return {
    async check(userId) {
      const t = now();
      const recent = (hits.get(userId) ?? []).filter(h => t - h < 60_000);
      if (recent.length >= perMinute) {
        hits.set(userId, recent);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + 60_000 - t) / 1000)) };
      }
      recent.push(t);
      hits.set(userId, recent);
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}
