import { describe, expect, test } from "bun:test";
import {
  classifyAuthError,
  DEFAULT_REDIRECT,
  parseEmail,
  parseOtpCode,
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
