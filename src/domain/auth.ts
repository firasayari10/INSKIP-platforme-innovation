import { z } from "zod";
import { err, ok, type Result } from "./result";

/**
 * Règles pures de l'authentification : validation des saisies, redirections sûres
 * et classification des erreurs du fournisseur d'auth en codes métier.
 * Aucune dépendance à React, Supabase ou au réseau.
 */

// ---------- E-mail ----------

export type EmailError = "email_empty" | "email_invalid" | "email_too_long";

const emailSchema = z.email();
const EMAIL_MAX_LENGTH = 254; // RFC 5321

export function parseEmail(input: string): Result<string, EmailError> {
  const email = input.trim().toLowerCase();
  if (email.length === 0) return err("email_empty");
  if (email.length > EMAIL_MAX_LENGTH) return err("email_too_long");
  if (!emailSchema.safeParse(email).success) return err("email_invalid");
  return ok(email);
}

// ---------- Code à usage unique ----------

export type OtpError = "otp_empty" | "otp_invalid_format";

/** Le code reçu par e-mail : 6 à 10 chiffres selon la configuration Supabase. Espaces tolérés. */
export function parseOtpCode(input: string): Result<string, OtpError> {
  const code = input.replace(/\s+/g, "");
  if (code.length === 0) return err("otp_empty");
  if (!/^\d{6,10}$/.test(code)) return err("otp_invalid_format");
  return ok(code);
}

// ---------- Redirection après connexion ----------

export const DEFAULT_REDIRECT = "/";
const AUTH_PATHS = ["/connexion", "/auth/"];

/**
 * N'accepte qu'un chemin interne à l'application, pour empêcher toute redirection
 * ouverte (`?next=https://site-malveillant.fr`, `//evil.com`, `/\evil.com`, `javascript:`).
 */
export function safeRedirectPath(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_REDIRECT;
  if (raw.length > 2048) return DEFAULT_REDIRECT;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return DEFAULT_REDIRECT;
  if (!raw.startsWith("/")) return DEFAULT_REDIRECT;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return DEFAULT_REDIRECT;
  if (raw.includes("\\")) return DEFAULT_REDIRECT;

  let url: URL;
  try {
    url = new URL(raw, "https://app.invalid");
  } catch {
    return DEFAULT_REDIRECT;
  }
  if (url.origin !== "https://app.invalid") return DEFAULT_REDIRECT;

  const path = `${url.pathname}${url.search}${url.hash}`;
  if (AUTH_PATHS.some(p => url.pathname === p || url.pathname.startsWith(p))) {
    return DEFAULT_REDIRECT; // évite les boucles vers les pages de connexion
  }
  return path;
}

// ---------- Classification des erreurs ----------

export type AuthErrorCode =
  | "rate_limited"
  | "code_invalid_or_expired"
  | "link_invalid_or_expired"
  | "link_other_browser"
  | "account_disabled"
  | "network"
  | "unknown";

/** Forme minimale d'une erreur d'auth, indépendante du SDK. */
export interface AuthErrorLike {
  code?: string | null;
  status?: number | null;
  name?: string | null;
  message?: string | null;
}

export type AuthAction = "send_link" | "verify_code" | "exchange_link";

/**
 * Codes signifiant « adresse non autorisée ». Ils ne doivent JAMAIS être révélés à
 * l'utilisateur : sinon le formulaire permettrait de deviner qui a un compte.
 */
const UNKNOWN_ACCOUNT_CODES = new Set(["otp_disabled", "signup_disabled", "user_not_found"]);

/**
 * Pour l'envoi du lien, une adresse inconnue est traitée comme un succès apparent
 * (anti-énumération des comptes). Retourne `null` dans ce cas.
 */
export function classifyAuthError(error: AuthErrorLike, action: AuthAction): AuthErrorCode | null {
  const code = error.code ?? "";

  if (action === "send_link" && UNKNOWN_ACCOUNT_CODES.has(code)) return null;

  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || error.status === 429) {
    return "rate_limited";
  }
  if (code === "user_banned") return "account_disabled";
  if (error.name === "AuthRetryableFetchError" || error.status === 0) return "network";

  if (code === "bad_code_verifier" || code === "flow_state_not_found") return "link_other_browser";
  if (code === "otp_expired" || code === "flow_state_expired") {
    return action === "verify_code" ? "code_invalid_or_expired" : "link_invalid_or_expired";
  }
  if (action === "verify_code" && UNKNOWN_ACCOUNT_CODES.has(code)) return "code_invalid_or_expired";
  if (action === "exchange_link") return "link_invalid_or_expired";

  return "unknown";
}

/** Délai minimal entre deux envois de lien (aligné sur la limite par défaut de Supabase). */
export const RESEND_COOLDOWN_SECONDS = 60;

export function secondsUntilResend(lastSentAt: number | null, now: number): number {
  if (lastSentAt === null) return 0;
  const elapsed = Math.floor((now - lastSentAt) / 1000);
  return Math.max(0, RESEND_COOLDOWN_SECONDS - elapsed);
}
