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

// ---------- Mot de passe ----------

export type PasswordError = "password_empty" | "password_too_short" | "password_too_long" | "password_too_weak";

export const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_BYTES = 72; // au-delà, bcrypt (Supabase Auth) ignore la fin du mot de passe

/** Au moins 10 caractères, une lettre et un chiffre. Le mot de passe n'est jamais modifié (espaces compris). */
export function parsePassword(input: string): Result<string, PasswordError> {
  if (input.length === 0) return err("password_empty");
  if (input.length < PASSWORD_MIN_LENGTH) return err("password_too_short");
  if (new TextEncoder().encode(input).length > PASSWORD_MAX_BYTES) return err("password_too_long");
  if (!/\p{L}/u.test(input) || !/\p{N}/u.test(input)) return err("password_too_weak");
  return ok(input);
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

// ---------- Retour depuis un lien reçu par e-mail ----------

/** Types de lien acceptés : connexion, invitation et confirmation d'inscription. */
const LINK_TYPES = ["email", "magiclink", "invite", "signup"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export type CallbackParams =
  | { kind: "token_hash"; tokenHash: string; type: LinkType }
  | { kind: "code"; code: string }
  | { kind: "error"; code: string }
  | { kind: "invalid" };

const TOKEN_HASH_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const PKCE_CODE_PATTERN = /^[A-Za-z0-9-]{16,256}$/;

/**
 * Interprète l'URL de /auth/callback.
 * - `token_hash` + `type` : liens des modèles d'e-mail personnalisés (connexion, invitation),
 *   vérifiés par l'application elle-même — fonctionnent dans n'importe quel navigateur ;
 * - `code` : flux PKCE du modèle par défaut (même navigateur que la demande) ;
 * - jetons d'accès dans l'ancre (flux implicite) : refusés, on ne les accepte pas.
 */
export function parseCallbackParams(search: string, hash: string): CallbackParams {
  const query = new URLSearchParams(search);
  const fragment = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);

  const errorCode = query.get("error_code") ?? fragment.get("error_code") ?? query.get("error") ?? fragment.get("error");
  if (errorCode) return { kind: "error", code: errorCode };

  const tokenHash = query.get("token_hash");
  if (tokenHash !== null) {
    const type = query.get("type");
    const isLinkType = (LINK_TYPES as readonly string[]).includes(type ?? "");
    if (!TOKEN_HASH_PATTERN.test(tokenHash) || !isLinkType) return { kind: "invalid" };
    return { kind: "token_hash", tokenHash, type: type as LinkType };
  }

  const code = query.get("code");
  if (code !== null && PKCE_CODE_PATTERN.test(code)) return { kind: "code", code };

  return { kind: "invalid" };
}

// ---------- Classification des erreurs ----------

export type AuthErrorCode =
  | "rate_limited"
  | "code_invalid_or_expired"
  | "link_invalid_or_expired"
  | "link_other_browser"
  | "account_disabled"
  | "invalid_credentials"
  | "email_not_confirmed"
  | "password_weak"
  | "signup_domain_not_allowed"
  | "signup_unavailable"
  | "network"
  | "unknown";

/** Forme minimale d'une erreur d'auth, indépendante du SDK. */
export interface AuthErrorLike {
  code?: string | null;
  status?: number | null;
  name?: string | null;
  message?: string | null;
}

export type AuthAction = "send_link" | "verify_code" | "exchange_link" | "sign_up" | "sign_in_password";

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

  if (action === "sign_in_password") {
    if (code === "email_not_confirmed") return "email_not_confirmed";
    if (code === "invalid_credentials" || error.status === 400) return "invalid_credentials";
    return "unknown";
  }
  if (action === "sign_up") {
    if (code === "weak_password") return "password_weak";
    if (code === "signup_disabled" || code === "email_provider_disabled") return "signup_unavailable";
    // Le refus du domaine par la base remonte comme une erreur générique du serveur d'auth.
    if (code === "unexpected_failure" || error.status === 500) return "signup_domain_not_allowed";
    return "unknown";
  }

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
