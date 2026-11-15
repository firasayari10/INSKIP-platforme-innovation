import { describe, expect, test } from "bun:test";
import { parsePublicConfig } from "@/lib/config";

const url = "https://abcd.supabase.co";

function jwtWithRole(role: string): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64({ role })}.signature`;
}

describe("parsePublicConfig", () => {
  test("accepte une URL et une clé publishable", () => {
    expect(parsePublicConfig({ supabaseUrl: ` ${url} `, supabasePublishableKey: "sb_publishable_abc" })).toEqual({
      ok: true,
      value: { supabaseUrl: url, supabasePublishableKey: "sb_publishable_abc" },
    });
  });

  test("accepte une ancienne clé anon", () => {
    expect(parsePublicConfig({ supabaseUrl: url, supabasePublishableKey: jwtWithRole("anon") }).ok).toBe(true);
  });

  test("signale une configuration absente", () => {
    expect(parsePublicConfig({})).toEqual({ ok: false, error: "missing" });
    expect(parsePublicConfig({ supabaseUrl: url, supabasePublishableKey: " " })).toEqual({
      ok: false,
      error: "missing",
    });
  });

  test("refuse une URL invalide", () => {
    expect(parsePublicConfig({ supabaseUrl: "pas-une-url", supabasePublishableKey: "sb_publishable_abc" })).toEqual({
      ok: false,
      error: "invalid_url",
    });
  });

  test("refuse de démarrer avec une clé secrète dans le navigateur", () => {
    expect(parsePublicConfig({ supabaseUrl: url, supabasePublishableKey: "sb_secret_abc" })).toEqual({
      ok: false,
      error: "secret_key_exposed",
    });
    expect(parsePublicConfig({ supabaseUrl: url, supabasePublishableKey: jwtWithRole("service_role") })).toEqual({
      ok: false,
      error: "secret_key_exposed",
    });
  });
});
