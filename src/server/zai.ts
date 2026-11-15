import type { ChatMessage, Citation } from "../domain/scoring";
import { err, ok } from "../domain/result";
import type { AgentCaller, AgentError, AgentRequest } from "./openrouter";
import { retryDelayMs, type RateLimiter } from "./rateLimiter";

/**
 * Client Z.ai (modèles GLM), API compatible OpenAI : POST {baseUrl}/chat/completions.
 * Référence : https://docs.z.ai/api-reference/llm/chat-completion
 * - recherche web intégrée : outil `web_search` ; les pages trouvées reviennent dans le champ
 *   `web_search` de la réponse (title, link, content…) → servent à vérifier les sources citées ;
 * - mode JSON (`response_format: json_object`) sans schéma imposé : le schéma est donc décrit dans
 *   les consignes, et la réponse est validée par zod côté orchestrateur ;
 * - tous les appels passent par le limiteur partagé ; saturation (HTTP 429, codes 1302/1305) →
 *   pause générale puis nouvelle tentative.
 */

export interface ZaiConfig {
  apiKey: string;
  baseUrl: string;
  webCount: number;
  timeoutMs: number;
  /** « Réflexion » des modèles GLM : plus lente et plus coûteuse, désactivée par défaut. */
  thinking: boolean;
  limiter: RateLimiter;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Codes d'erreur Z.ai signifiant « trop de requêtes / surcharge temporaire ». */
const SATURATION_CODES = new Set(["1302", "1303", "1305"]);
const BALANCE_CODES = new Set(["1113"]);
const UNKNOWN_MODEL_CODES = new Set(["1211"]);

export function withSchemaInstruction(messages: ChatMessage[], schema: Record<string, unknown>): ChatMessage[] {
  const instruction = `\n\nFormat de réponse OBLIGATOIRE : un unique objet JSON valide, sans texte ni bloc de code autour, conforme à ce schéma JSON (respecte les noms de champs, les types, les valeurs autorisées et les bornes) :\n${JSON.stringify(schema)}`;
  return messages.map((m, i) => (i === 0 && m.role === "system" ? { ...m, content: m.content + instruction } : m));
}

interface ZaiResponse {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  web_search?: { title?: unknown; link?: unknown; content?: unknown }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { code?: string | number; message?: string };
}

function citationsOf(results: ZaiResponse["web_search"]): Citation[] {
  return (results ?? []).flatMap(r =>
    typeof r?.link === "string"
      ? [{ url: r.link, title: typeof r.title === "string" ? r.title : null, content: typeof r.content === "string" ? r.content.slice(0, 1000) : null }]
      : [],
  );
}

function parseContent(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}

export function createZaiCaller(config: ZaiConfig): AgentCaller {
  const doFetch = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const maxRetries = config.maxRetries ?? 4;
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

  return async (request: AgentRequest) => {
    const body = JSON.stringify({
      model: request.model,
      messages: withSchemaInstruction(request.messages, request.schema),
      temperature: 0.2,
      max_tokens: 4096,
      response_format: { type: "json_object" },
      thinking: { type: config.thinking ? "enabled" : "disabled" },
      ...(request.web
        ? {
            tools: [
              {
                type: "web_search",
                web_search: {
                  enable: true,
                  search_engine: "search_pro_jina",
                  search_result: true,
                  count: config.webCount,
                  content_size: "medium",
                },
              },
            ],
          }
        : {}),
    });

    let last: AgentError = { code: "reseau", detail: "aucune tentative" };
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let response: Response;
      let text: string;
      try {
        ({ response, text } = await config.limiter.run(async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), config.timeoutMs);
          try {
            const r = await doFetch(endpoint, {
              method: "POST",
              headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
              body,
              signal: controller.signal,
            });
            return { response: r, text: await r.text() };
          } finally {
            clearTimeout(timer);
          }
        }));
      } catch (e) {
        last =
          e instanceof Error && e.name === "AbortError"
            ? { code: "delai_depasse", detail: `délai de ${config.timeoutMs} ms dépassé` }
            : { code: "reseau", detail: e instanceof Error ? e.message : "erreur réseau" };
        await sleep(retryDelayMs(attempt, null, config.random));
        continue;
      }

      let raw: ZaiResponse = {};
      try {
        raw = JSON.parse(text) as ZaiResponse;
      } catch {
        if (response.ok) return err({ code: "reponse_invalide", detail: "réponse HTTP non JSON" });
      }
      const providerCode = raw.error?.code === undefined ? "" : String(raw.error.code);

      // Le code Z.ai prime sur le statut HTTP : un crédit épuisé arrive avec un statut 429 et ne
      // doit surtout pas être réessayé comme une simple saturation.
      if (response.status === 402 || BALANCE_CODES.has(providerCode))
        return err({ code: "credit_insuffisant", detail: `HTTP ${response.status} code ${providerCode}` });
      if (response.status === 401 || response.status === 403) return err({ code: "cle_invalide", detail: `HTTP ${response.status}` });

      if (response.status === 429 || SATURATION_CODES.has(providerCode) || response.status >= 500) {
        const delay = retryDelayMs(attempt, response.headers.get("retry-after"), config.random);
        config.limiter.pause(delay); // tout le serveur ralentit, pas seulement cet appel
        last = { code: "quota_depasse", detail: `HTTP ${response.status} code ${providerCode || "-"}` };
        await sleep(delay);
        continue;
      }
      if (response.status === 404 || UNKNOWN_MODEL_CODES.has(providerCode))
        return err({ code: "modele_indisponible", detail: `HTTP ${response.status} ${String(raw.error?.message ?? "").slice(0, 200)}` });
      if (!response.ok || raw.error)
        return err({ code: "reponse_invalide", detail: `HTTP ${response.status} ${String(raw.error?.message ?? "").slice(0, 200)}` });

      const content = raw.choices?.[0]?.message?.content;
      if (!content) return err({ code: "reponse_invalide", detail: "réponse vide" });
      let json: unknown;
      try {
        json = parseContent(content);
      } catch {
        return err({ code: "reponse_invalide", detail: "contenu non JSON" });
      }
      return ok({
        json,
        citations: citationsOf(raw.web_search),
        usage: {
          promptTokens: raw.usage?.prompt_tokens ?? 0,
          completionTokens: raw.usage?.completion_tokens ?? 0,
          costUsd: 0, // non fourni par l'API Z.ai
        },
        model: raw.model ?? request.model,
      });
    }
    return err(last);
  };
}
