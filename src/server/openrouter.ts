import type { ChatMessage, Citation } from "../domain/scoring";
import { err, ok, type Result } from "../domain/result";

/**
 * Client OpenRouter (côté serveur uniquement : la clé n'atteint jamais le navigateur).
 * - sortie structurée (schéma JSON) ;
 * - recherche web optionnelle (plugin « web ») : les pages trouvées reviennent en annotations ;
 * - fournisseurs qui conservent ou réutilisent les données exclus (`data_collection: "deny"`) ;
 * - délai maximal, nouvelles tentatives avec attente croissante sur erreurs passagères.
 */

export type AgentErrorCode =
  | "cle_invalide"
  | "credit_insuffisant"
  | "modele_indisponible"
  | "quota_depasse"
  | "delai_depasse"
  | "reseau"
  | "reponse_invalide";

export interface AgentError {
  code: AgentErrorCode;
  /** Détail technique pour les journaux serveur (jamais affiché tel quel, jamais de donnée personnelle). */
  detail: string;
}

export interface AgentRequest {
  model: string;
  messages: ChatMessage[];
  schemaName: string;
  schema: Record<string, unknown>;
  web: boolean;
}

export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface AgentResponse {
  json: unknown;
  citations: Citation[];
  usage: AgentUsage;
  model: string;
}

export type AgentCaller = (request: AgentRequest) => Promise<Result<AgentResponse, AgentError>>;

export interface OpenRouterConfig {
  apiKey: string;
  webMaxResults: number;
  timeoutMs: number;
  appUrl: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const RETRY_DELAYS_MS = [1_500, 4_000];

/** Mode strict : tout objet du schéma refuse les propriétés non prévues. */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "$schema") continue;
    out[k] = strictSchema(v);
  }
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

/** Extrait le JSON d'une réponse, y compris s'il est entouré d'un bloc de code. */
export function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}

interface RawResponse {
  model?: string;
  choices?: { message?: { content?: string | null; annotations?: unknown[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { code?: number | string; message?: string };
}

function citationsOf(annotations: unknown[] | undefined): Citation[] {
  if (!annotations) return [];
  const out: Citation[] = [];
  for (const a of annotations) {
    if (!a || typeof a !== "object") continue;
    const c = (a as { type?: string; url_citation?: { url?: unknown; title?: unknown; content?: unknown } }).url_citation;
    if ((a as { type?: string }).type === "url_citation" && c && typeof c.url === "string") {
      out.push({
        url: c.url,
        title: typeof c.title === "string" ? c.title : null,
        content: typeof c.content === "string" ? c.content.slice(0, 1000) : null,
      });
    }
  }
  return out;
}

function errorFromStatus(status: number, body: string): AgentError | "retry" {
  if (status === 401 || status === 403) return { code: "cle_invalide", detail: `HTTP ${status}` };
  if (status === 402) return { code: "credit_insuffisant", detail: "HTTP 402" };
  if (status === 404) return { code: "modele_indisponible", detail: `HTTP 404 ${body.slice(0, 200)}` };
  if (status === 429 || status >= 500) return "retry";
  return { code: "reponse_invalide", detail: `HTTP ${status} ${body.slice(0, 200)}` };
}

export function createOpenRouterCaller(config: OpenRouterConfig): AgentCaller {
  const doFetch = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));

  return async request => {
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      temperature: 0.2,
      response_format: {
        type: "json_schema",
        json_schema: { name: request.schemaName, strict: true, schema: strictSchema(request.schema) },
      },
      ...(request.web ? { plugins: [{ id: "web", max_results: config.webMaxResults }] } : {}),
      provider: { data_collection: "deny", require_parameters: true },
      usage: { include: true },
    });

    let last: AgentError = { code: "reseau", detail: "aucune tentative" };
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      let response: Response;
      try {
        response = await doFetch(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": config.appUrl,
            "X-Title": "Challenge Innovation",
          },
          body,
          signal: controller.signal,
        });
      } catch (e) {
        last = controller.signal.aborted
          ? { code: "delai_depasse", detail: `délai de ${config.timeoutMs} ms dépassé` }
          : { code: "reseau", detail: e instanceof Error ? e.message : "erreur réseau" };
        continue;
      } finally {
        clearTimeout(timer);
      }

      const text = await response.text();
      if (!response.ok) {
        const e = errorFromStatus(response.status, text);
        if (e === "retry") {
          last = { code: response.status === 429 ? "quota_depasse" : "reseau", detail: `HTTP ${response.status}` };
          continue;
        }
        return err(e);
      }

      let raw: RawResponse;
      try {
        raw = JSON.parse(text) as RawResponse;
      } catch {
        return err({ code: "reponse_invalide", detail: "réponse HTTP non JSON" });
      }
      if (raw.error) return err({ code: "reponse_invalide", detail: String(raw.error.message ?? raw.error.code) });
      const message = raw.choices?.[0]?.message;
      if (!message?.content) return err({ code: "reponse_invalide", detail: "réponse vide" });

      let json: unknown;
      try {
        json = extractJson(message.content);
      } catch {
        return err({ code: "reponse_invalide", detail: "contenu non JSON" });
      }
      return ok({
        json,
        citations: citationsOf(message.annotations),
        usage: {
          promptTokens: raw.usage?.prompt_tokens ?? 0,
          completionTokens: raw.usage?.completion_tokens ?? 0,
          costUsd: raw.usage?.cost ?? 0,
        },
        model: raw.model ?? request.model,
      });
    }
    return err(last);
  };
}
