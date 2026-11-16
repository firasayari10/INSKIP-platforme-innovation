import { describe, expect, test } from "bun:test";
import {
  classifyAuthError,
  DEFAULT_REDIRECT,
  parseEmail,
  parseCallbackParams,
  parseOtpCode,
  parsePassword,
  RESEND_COOLDOWN_SECONDS,
  safeRedirectPath,
  secondsUntilResend,
} from "@/domain/auth";

describe("parseEmail", () => {
  test("normalise une adresse valide (espaces, majuscules)", () => {
    expect(parseEmail("  Jean.Dupont@Exemple.FR ")).toEqual({ ok: true, value: "jean.dupont@exemple.fr" });
  });

  test("refuse une saisie vide ou faite d'espaces", () => {
    expect(parseEmail("")).toEqual({ ok: false, error: "email_empty" });
    expect(parseEmail("   ")).toEqual({ ok: false, error: "email_empty" });
  });

  test.each(["jean", "jean@", "@exemple.fr", "jean@exemple", "jean dupont@exemple.fr"])(
    "refuse une adresse mal formée : %p",
    input => {
      expect(parseEmail(input)).toEqual({ ok: false, error: "email_invalid" });
    },
  );

  test("refuse une adresse de plus de 254 caractères", () => {
    expect(parseEmail(`${"a".repeat(250)}@x.fr`)).toEqual({ ok: false, error: "email_too_long" });
  });
});

describe("parseOtpCode", () => {
  test("accepte 6 chiffres et ignore les espaces", () => {
    expect(parseOtpCode(" 123 456 ")).toEqual({ ok: true, value: "123456" });
  });

  test("accepte jusqu'à 10 chiffres (configuration Supabase)", () => {
    expect(parseOtpCode("1234567890")).toEqual({ ok: true, value: "1234567890" });
  });

  test("refuse un code vide", () => {
    expect(parseOtpCode("")).toEqual({ ok: false, error: "otp_empty" });
  });

  test.each(["12345", "12345a", "12345678901", "abcdef"])("refuse un format incorrect : %p", input => {
    expect(parseOtpCode(input)).toEqual({ ok: false, error: "otp_invalid_format" });
  });
});

describe("safeRedirectPath", () => {
  test("conserve un chemin interne avec paramètres et ancre", () => {
    expect(safeRedirectPath("/challenges/42?filtre=rh#notes")).toBe("/challenges/42?filtre=rh#notes");
  });

  test("renvoie l'accueil si rien n'est fourni", () => {
    expect(safeRedirectPath(null)).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath(undefined)).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath("")).toBe(DEFAULT_REDIRECT);
  });

  test.each([
    "https://site-malveillant.fr",
    "//site-malveillant.fr",
    "/\\site-malveillant.fr",
    "/%5Csite-malveillant.fr\\x",
    "javascript:alert(1)",
    "challenges",
    "/ok\nSet-Cookie: x",
    "/\tevil",
  ])("bloque une redirection ouverte ou dangereuse : %p", input => {
    expect(safeRedirectPath(input)).toBe(DEFAULT_REDIRECT);
  });

  test("évite de renvoyer vers les pages de connexion (boucle)", () => {
    expect(safeRedirectPath("/connexion?next=/x")).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath("/auth/callback")).toBe(DEFAULT_REDIRECT);
  });

  test("refuse un chemin anormalement long", () => {
    expect(safeRedirectPath(`/${"a".repeat(3000)}`)).toBe(DEFAULT_REDIRECT);
  });
});

describe("classifyAuthError", () => {
  test.each(["otp_disabled", "signup_disabled", "user_not_found"])(
    "ne révèle pas qu'une adresse est inconnue lors de l'envoi du lien (%p)",
    code => {
      expect(classifyAuthError({ code, status: 422 }, "send_link")).toBeNull();
    },
  );

  test("signale la limite d'envoi", () => {
    expect(classifyAuthError({ code: "over_email_send_rate_limit", status: 429 }, "send_link")).toBe("rate_limited");
    expect(classifyAuthError({ status: 429 }, "verify_code")).toBe("rate_limited");
  });

  test("distingue un code expiré d'un lien expiré", () => {
    expect(classifyAuthError({ code: "otp_expired" }, "verify_code")).toBe("code_invalid_or_expired");
    expect(classifyAuthError({ code: "otp_expired" }, "exchange_link")).toBe("link_invalid_or_expired");
  });

  test("détecte un lien ouvert dans un autre navigateur (PKCE)", () => {
    expect(classifyAuthError({ code: "bad_code_verifier" }, "exchange_link")).toBe("link_other_browser");
    expect(classifyAuthError({ code: "flow_state_not_found" }, "exchange_link")).toBe("link_other_browser");
  });

  test("reconnaît une erreur réseau", () => {
    expect(classifyAuthError({ name: "AuthRetryableFetchError", status: 0 }, "send_link")).toBe("network");
  });

  test("un compte inconnu lors de la vérification du code reste un code invalide", () => {
    expect(classifyAuthError({ code: "user_not_found" }, "verify_code")).toBe("code_invalid_or_expired");
  });

  test("compte désactivé", () => {
    expect(classifyAuthError({ code: "user_banned" }, "verify_code")).toBe("account_disabled");
  });

  test("toute autre erreur est inconnue", () => {
    expect(classifyAuthError({ code: "quelque_chose", status: 500 }, "send_link")).toBe("unknown");
  });
});

describe("secondsUntilResend", () => {
  test("aucun envoi précédent : pas d'attente", () => {
    expect(secondsUntilResend(null, 1_000_000)).toBe(0);
  });

  test("décompte depuis le dernier envoi puis s'arrête à zéro", () => {
    const sentAt = 1_000_000;
    expect(secondsUntilResend(sentAt, sentAt)).toBe(RESEND_COOLDOWN_SECONDS);
    expect(secondsUntilResend(sentAt, sentAt + 15_000)).toBe(RESEND_COOLDOWN_SECONDS - 15);
    expect(secondsUntilResend(sentAt, sentAt + 120_000)).toBe(0);
  });
});

describe("parseCallbackParams", () => {
  const hash = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef0123456789";

  test("reconnaît un lien d'invitation (token_hash + type invite)", () => {
    expect(parseCallbackParams(`?token_hash=${hash}&type=invite`, "")).toEqual({
      kind: "token_hash",
      tokenHash: hash,
      type: "invite",
    });
  });

  test("reconnaît un lien de connexion (type email ou magiclink)", () => {
    expect(parseCallbackParams(`?next=%2F&token_hash=${hash}&type=email`, "")).toMatchObject({ type: "email" });
    expect(parseCallbackParams(`?token_hash=${hash}&type=magiclink`, "")).toMatchObject({ type: "magiclink" });
  });

  test("refuse un type non prévu (récupération de mot de passe, changement d'e-mail…)", () => {
    expect(parseCallbackParams(`?token_hash=${hash}&type=recovery`, "")).toEqual({ kind: "invalid" });
    expect(parseCallbackParams(`?token_hash=${hash}&type=email_change`, "")).toEqual({ kind: "invalid" });
  });

  test("refuse un jeton mal formé", () => {
    expect(parseCallbackParams("?token_hash=<script>&type=invite", "")).toEqual({ kind: "invalid" });
    expect(parseCallbackParams("?token_hash=&type=invite", "")).toEqual({ kind: "invalid" });
  });

  test("reconnaît un code PKCE (modèle d'e-mail par défaut)", () => {
    expect(parseCallbackParams("?code=0f1e2d3c-aaaa-bbbb-cccc-0123456789ab", "")).toEqual({
      kind: "code",
      code: "0f1e2d3c-aaaa-bbbb-cccc-0123456789ab",
    });
  });

  test("remonte une erreur transmise dans l'URL ou dans l'ancre", () => {
    expect(parseCallbackParams("?error=access_denied&error_code=otp_expired", "")).toEqual({
      kind: "error",
      code: "otp_expired",
    });
    expect(parseCallbackParams("", "#error=access_denied&error_code=otp_expired&error_description=x")).toEqual({
      kind: "error",
      code: "otp_expired",
    });
  });

  test("ignore les jetons d'accès dans l'ancre (flux implicite non accepté)", () => {
    expect(parseCallbackParams("", "#access_token=abc&refresh_token=def&type=invite")).toEqual({ kind: "invalid" });
  });

  test("sans paramètre : lien incomplet", () => {
    expect(parseCallbackParams("", "")).toEqual({ kind: "invalid" });
  });
});

describe("parsePassword", () => {
  test("accepte un mot de passe de 10 caractères avec lettres et chiffres", () => {
    expect(parsePassword("innovation26")).toEqual({ ok: true, value: "innovation26" });
  });
  test("refuse un mot de passe vide", () => {
    expect(parsePassword("")).toEqual({ ok: false, error: "password_empty" });
  });
  test("refuse un mot de passe trop court", () => {
    expect(parsePassword("abc12")).toEqual({ ok: false, error: "password_too_short" });
  });
  test("refuse un mot de passe trop long (limite bcrypt de 72 octets)", () => {
    expect(parsePassword("a1".repeat(40))).toEqual({ ok: false, error: "password_too_long" });
  });
  test("refuse un mot de passe sans chiffre ou sans lettre", () => {
    expect(parsePassword("motdepasselong")).toEqual({ ok: false, error: "password_too_weak" });
    expect(parsePassword("12345678901")).toEqual({ ok: false, error: "password_too_weak" });
  });
  test("ne retire pas les espaces : ils font partie du mot de passe", () => {
    expect(parsePassword(" innovation26 ")).toEqual({ ok: true, value: " innovation26 " });
  });
});

describe("classifyAuthError : inscription et mot de passe", () => {
  test("identifiants incorrects à la connexion par mot de passe", () => {
    expect(classifyAuthError({ code: "invalid_credentials", status: 400 }, "sign_in_password")).toBe("invalid_credentials");
  });
  test("adresse pas encore confirmée", () => {
    expect(classifyAuthError({ code: "email_not_confirmed", status: 400 }, "sign_in_password")).toBe("email_not_confirmed");
  });
  test("mot de passe jugé trop faible par le serveur", () => {
    expect(classifyAuthError({ code: "weak_password", status: 422 }, "sign_up")).toBe("password_weak");
  });
  test("domaine refusé par la base (erreur générique du serveur à l'inscription)", () => {
    expect(classifyAuthError({ code: "unexpected_failure", status: 500 }, "sign_up")).toBe("signup_domain_not_allowed");
  });
  test("inscriptions désactivées côté serveur", () => {
    expect(classifyAuthError({ code: "signup_disabled", status: 422 }, "sign_up")).toBe("signup_unavailable");
  });
  test("trop d'envois d'e-mails à l'inscription", () => {
    expect(classifyAuthError({ code: "over_email_send_rate_limit", status: 429 }, "sign_up")).toBe("rate_limited");
  });
});

describe("parseCallbackParams : confirmation d'inscription", () => {
  test("accepte un lien de confirmation d'inscription (type signup)", () => {
    expect(parseCallbackParams("?token_hash=abcdefghijklmnop1234&type=signup", "")).toEqual({
      kind: "token_hash",
      tokenHash: "abcdefghijklmnop1234",
      type: "signup",
    });
  });
});