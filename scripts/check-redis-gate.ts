/**
 * Vérification manuelle des scripts Lua de la passerelle sur une VRAIE base Upstash (même contrat
 * que tests/unit/gate.test.ts sur le magasin mémoire). Hors `bun test` (qui interdit le réseau).
 * Usage : bun run scripts/check-redis-gate.ts   (lit UPSTASH_REDIS_REST_URL/TOKEN dans .env.local)
 * Clés de test sous un préfixe aléatoire, supprimées à la fin. N'appelle aucun fournisseur d'IA.
 */
import { Redis } from "@upstash/redis";
import { createUpstashGateStore } from "../src/server/gate";

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  console.log("UPSTASH_REDIS_REST_URL / TOKEN absents : vérification ignorée.");
  process.exit(0);
}

const redis = new Redis({ url, token });
const prefix = `test-gate-${crypto.randomUUID().slice(0, 8)}`;
const s = createUpstashGateStore(redis, prefix);
let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok    " : "ÉCHEC "} ${label}${ok ? "" : ` (obtenu ${JSON.stringify(actual)}, attendu ${JSON.stringify(expected)})`}`);
};

try {
  check("sémaphore : 1er créneau", await s.tryAcquireSlot("a", 2, 10_000, 0), true);
  check("sémaphore : 2e créneau", await s.tryAcquireSlot("b", 2, 10_000, 0), true);
  check("sémaphore : 3e refusé", await s.tryAcquireSlot("c", 2, 10_000, 0), false);
  await s.releaseSlot("a");
  check("sémaphore : créneau libéré réutilisable", await s.tryAcquireSlot("c", 2, 10_000, 1), true);
  check("sémaphore : bail expiré récupéré", await s.tryAcquireSlot("d", 2, 30_000, 10_001), true);

  check("jetons : 1er immédiat", await s.takeToken(60, 2, 0), 0);
  check("jetons : 2e immédiat", await s.takeToken(60, 2, 0), 0);
  const wait = await s.takeToken(60, 2, 0);
  check("jetons : 3e attend ≈ 1 s", wait > 900 && wait <= 1_000, true);
  check("jetons : regagné après 1 s", await s.takeToken(60, 2, 1_000), 0);

  const now = Date.now();
  await s.extendPause(now + 5_000, now);
  await s.extendPause(now + 2_000, now);
  check("pause : garde la plus lointaine", await s.getPauseUntil(), now + 5_000);

  await s.recordFailure(3, 60_000, 100);
  await s.recordFailure(3, 60_000, 100);
  await s.recordSuccess();
  await s.recordFailure(3, 60_000, 100);
  await s.recordFailure(3, 60_000, 100);
  check("circuit : fermé sous le seuil", await s.getCircuitOpenUntil(), 0);
  await s.recordFailure(3, 60_000, 100);
  check("circuit : ouvert au seuil", await s.getCircuitOpenUntil(), 60_100);
} finally {
  await redis.del(`${prefix}:inflight`, `${prefix}:rate`, `${prefix}:pause_until`, `${prefix}:circuit`);
}

console.log(failures === 0 ? "\nTous les contrôles passent sur Upstash." : `\n${failures} contrôle(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);
