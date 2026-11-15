import type { SupabaseClient } from "@supabase/supabase-js";
import type { Citation } from "../domain/scoring";

/**
 * Cache des sorties d'agents (ADR 0003 §1), table `agent_outputs` : une entrée par
 * (challenge, empreinte exacte de la requête). Jamais partagé entre challenges. Lu et écrit par le
 * serveur seul (clé secrète) ; le navigateur n'y a aucun accès. Les entrées sont revalidées par
 * leur schéma à la lecture par l'appelant.
 */

export type AgentRole = "analyste" | "consultant" | "associe";

export interface CachedOutput {
  output: unknown;
  citations: Citation[];
  model: string;
}

export interface AgentCacheEntry extends CachedOutput {
  agent: AgentRole;
  criterionKey: string | null;
  fingerprint: string;
  promptVersion: string;
  usage: Record<string, number>;
}

export interface AgentCache {
  get(fingerprint: string): Promise<CachedOutput | null>;
  put(entry: AgentCacheEntry): Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createSupabaseAgentCache(db: SupabaseClient, challengeId: string, maxAgeDays: number): AgentCache {
  return {
    async get(fingerprint) {
      const { data, error } = await db
        .from("agent_outputs")
        .select("output, citations, model")
        .eq("challenge_id", challengeId)
        .eq("fingerprint", fingerprint)
        .gte("created_at", new Date(Date.now() - maxAgeDays * DAY_MS).toISOString())
        .maybeSingle();
      if (error || !data) return null; // cache indisponible : on appelle simplement le modèle
      return {
        output: data.output,
        citations: Array.isArray(data.citations) ? (data.citations as Citation[]) : [],
        model: String(data.model),
      };
    },
    async put(entry) {
      const { error } = await db.from("agent_outputs").insert({
        challenge_id: challengeId,
        agent: entry.agent,
        criterion_key: entry.criterionKey,
        fingerprint: entry.fingerprint,
        prompt_version: entry.promptVersion,
        model: entry.model,
        output: entry.output,
        citations: entry.citations.slice(0, 30),
        usage: entry.usage,
      });
      // 23505 : une autre évaluation a écrit la même entrée entre-temps ; sans conséquence.
      if (error && error.code !== "23505") {
        console.error(`[agent-cache] écriture impossible (${entry.fingerprint.slice(0, 8)}, ${entry.agent}) : ${error.code}`);
      }
    },
  };
}

/** Cache en mémoire (tests, ou absence de base). */
export function createMemoryAgentCache(): AgentCache & { entries: Map<string, AgentCacheEntry> } {
  const entries = new Map<string, AgentCacheEntry>();
  return {
    entries,
    async get(fingerprint) {
      const e = entries.get(fingerprint);
      return e ? { output: e.output, citations: e.citations, model: e.model } : null;
    },
    async put(entry) {
      if (!entries.has(entry.fingerprint)) entries.set(entry.fingerprint, entry);
    },
  };
}
