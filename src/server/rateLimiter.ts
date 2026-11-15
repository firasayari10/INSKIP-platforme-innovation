/**
 * Limiteur d'appels vers le fournisseur d'IA, partagé par toutes les évaluations du serveur :
 * - au plus `maxConcurrent` appels simultanés ;
 * - au plus `requestsPerMinute` appels sur une fenêtre glissante de 60 s ;
 * - au moins `minIntervalMs` entre deux départs ;
 * - `pause(ms)` : quand le fournisseur signale une saturation, plus aucun appel ne part avant la fin.
 * L'horloge est injectable pour les tests.
 *
 * Limite connue : en hébergement « serverless » (Vercel), chaque instance a son propre limiteur.
 */

export interface RateLimitConfig {
  maxConcurrent: number;
  requestsPerMinute: number;
  minIntervalMs: number;
}

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface RateLimiter {
  run<T>(task: () => Promise<T>): Promise<T>;
  pause(ms: number): void;
  /** Signale l'issue d'un appel au coupe-circuit (passerelle partagée). */
  report?(outcome: "succes" | "echec_passager"): Promise<void>;
}

const realClock: Clock = { now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)) };
const WINDOW_MS = 60_000;

export function createRateLimiter(config: RateLimitConfig, clock: Clock = realClock): RateLimiter {
  let active = 0;
  let lastStart = -Infinity;
  let pausedUntil = 0;
  const starts: number[] = [];
  const waiting: (() => void)[] = [];
  // Les départs sont accordés un par un, dans l'ordre d'arrivée.
  let gate: Promise<void> = Promise.resolve();

  const acquireSlot = () =>
    active < config.maxConcurrent ? ((active += 1), Promise.resolve()) : new Promise<void>(r => waiting.push(r));

  const releaseSlot = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  const waitForTurn = async () => {
    for (;;) {
      const now = clock.now();
      while (starts.length > 0 && now - starts[0]! >= WINDOW_MS) starts.shift();
      const waits = [
        pausedUntil - now,
        lastStart + config.minIntervalMs - now,
        starts.length >= config.requestsPerMinute ? starts[0]! + WINDOW_MS - now : 0,
      ];
      const wait = Math.max(0, ...waits);
      if (wait <= 0) break;
      await clock.sleep(wait);
    }
    lastStart = clock.now();
    starts.push(lastStart);
  };

  return {
    async run(task) {
      await acquireSlot();
      try {
        const turn = gate.then(waitForTurn);
        gate = turn.catch(() => {});
        await turn;
        return await task();
      } finally {
        releaseSlot();
      }
    },
    pause(ms) {
      pausedUntil = Math.max(pausedUntil, clock.now() + ms);
    },
  };
}

const MAX_DELAY_MS = 60_000;

/** Délai avant nouvelle tentative : Retry-After s'il est fourni, sinon 2 s, 4 s, 8 s… plafonné. */
export function retryDelayMs(attempt: number, retryAfter: string | null, random: () => number = Math.random): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_DELAY_MS);
  const base = 2_000 * 2 ** attempt;
  return Math.min(base + Math.round(random() * 1_000), MAX_DELAY_MS);
}
