import { z } from "zod";
import { err, ok, type Result } from "@/domain/result";

/**
 * Configuration publique du navigateur. Seules les variables `BUN_PUBLIC_*` y arrivent,
 * et elles doivent être publiques par nature (CLAUDE.md §7).
 */
export interface PublicConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
}

export type ConfigError = "missing" | "invalid_url" | "secret_key_exposed";

const urlSchema = z.url({ protocol: /^https?$/ });

export function parsePublicConfig(raw: {
  supabaseUrl?: string;
  supabasePublishableKey?: string;
}): Result<PublicConfig, ConfigError> {
  const supabaseUrl = raw.supabaseUrl?.trim() ?? "";
  const supabasePublishableKey = raw.supabasePublishableKey?.trim() ?? "";

  if (!supabaseUrl || !supabasePublishableKey) return err("missing");
  if (!urlSchema.safeParse(supabaseUrl).success) return err("invalid_url");
  // Garde-fou : une clé secrète ne doit jamais être embarquée dans le front.
  if (supabasePublishableKey.startsWith("sb_secret_") || looksLikeServiceRoleJwt(supabasePublishableKey)) {
    return err("secret_key_exposed");
  }
  return ok({ supabaseUrl, supabasePublishableKey });
}

function looksLikeServiceRoleJwt(key: string): boolean {
  const payload = key.split(".")[1];
  if (!payload) return false;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { role?: unknown };
    return json.role === "service_role";
  } catch {
    return false;
  }
}

export const publicConfig = parsePublicConfig({
  // Références littérales : Bun les remplace à la compilation.
  supabaseUrl: process.env.BUN_PUBLIC_SUPABASE_URL,
  supabasePublishableKey: process.env.BUN_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
});
