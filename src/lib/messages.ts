import type { AuthErrorCode, EmailError, OtpError } from "@/domain/auth";
import type { ConfigError } from "./config";

/** Seul endroit où les codes d'erreur deviennent des phrases pour l'utilisateur. */

export const emailErrorMessages: Record<EmailError, string> = {
  email_empty: "Saisissez votre adresse e-mail professionnelle.",
  email_invalid: "Cette adresse e-mail ne semble pas valide. Vérifiez qu'elle contient bien un « @ » et un domaine.",
  email_too_long: "Cette adresse e-mail est trop longue.",
};

export const otpErrorMessages: Record<OtpError, string> = {
  otp_empty: "Saisissez le code reçu par e-mail.",
  otp_invalid_format: "Le code reçu par e-mail ne contient que des chiffres. Vérifiez votre saisie.",
};

export const authErrorMessages: Record<AuthErrorCode, string> = {
  rate_limited: "Trop de demandes en peu de temps. Patientez une minute avant de réessayer.",
  code_invalid_or_expired: "Ce code est incorrect ou a expiré. Vérifiez-le ou demandez un nouvel e-mail.",
  link_invalid_or_expired: "Ce lien de connexion n'est plus valable. Demandez-en un nouveau, il est valable une heure.",
  link_other_browser:
    "Ce lien a été ouvert dans un autre navigateur que celui de la demande. Ouvrez-le dans le même navigateur, ou saisissez le code reçu dans l'e-mail.",
  account_disabled: "Votre accès a été désactivé. Contactez l'administrateur de la plateforme.",
  network: "Connexion au serveur impossible. Vérifiez votre accès à Internet puis réessayez.",
  unknown: "Une erreur inattendue s'est produite. Réessayez dans quelques instants.",
};

export const configErrorMessages: Record<ConfigError, string> = {
  missing: "La connexion à la base de données n'est pas configurée.",
  invalid_url: "L'adresse de la base de données configurée n'est pas valide.",
  secret_key_exposed: "Une clé secrète a été fournie au navigateur. L'application refuse de démarrer par sécurité.",
};
