import type { FieldKey, FileError, RowErrorCode, RowWarningCode } from "@/domain/importAnalysis";
import type { CsvError } from "./csv";
import type { DataError } from "./data";
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

// ---------- Données ----------

export const dataErrorMessages: Record<DataError, string> = {
  acces_refuse: "Vous n'avez pas accès à ce challenge. Demandez à son créateur de vous ajouter.",
  introuvable: "Ce challenge n'existe pas ou n'est plus accessible.",
  donnees_invalides: "Les données reçues sont incomplètes. Réessayez ; si le problème persiste, contactez l'administrateur.",
  reseau: "Connexion au serveur impossible. Vérifiez votre accès à Internet puis réessayez.",
  service_non_initialise:
    "La base de données de l'application n'est pas encore installée. Contactez l'administrateur de la plateforme.",
  inconnue: "Une erreur inattendue s'est produite. Réessayez dans quelques instants.",
};

// ---------- Import ----------

export const fieldLabels: Record<FieldKey, string> = {
  external_ref: "Identifiant",
  submitted_at: "Date de dépôt",
  first_name: "Prénom",
  last_name: "Nom",
  direction: "Direction",
  site: "Site",
  theme: "Thème",
  title: "Titre",
  description: "Description",
  expected_benefits: "Bénéfices attendus",
  budget: "Budget estimé",
};

export const csvErrorMessages: Record<CsvError, string> = {
  format_non_supporte: "Ce format n'est pas pris en charge. Enregistrez votre fichier au format CSV depuis Excel (Fichier → Enregistrer sous → CSV).",
  fichier_trop_volumineux: "Ce fichier dépasse 5 Mo. Vérifiez qu'il s'agit bien de l'export des idées.",
  fichier_vide: "Ce fichier est vide.",
  lecture_impossible: "Le fichier n'a pas pu être lu correctement (guillemets mal fermés). Réexportez-le depuis le formulaire puis réessayez.",
};

export function fileErrorMessage(error: FileError): string {
  switch (error.code) {
    case "fichier_vide":
      return "Ce fichier ne contient aucune ligne d'en-tête.";
    case "colonnes_manquantes":
      return `Colonnes obligatoires introuvables : ${error.missing.map(f => fieldLabels[f]).join(", ")}. Vérifiez que vous avez exporté le bon fichier et que la première ligne contient bien les noms de colonnes.`;
    case "colonnes_en_double":
      return `Plusieurs colonnes correspondent au même champ : ${error.headers.join(", ")}. Supprimez la colonne en trop puis réessayez.`;
    case "trop_de_lignes":
      return `Ce fichier contient ${error.found} lignes ; la limite est de ${error.max}. Découpez-le en plusieurs fichiers.`;
  }
}

export const rowErrorLabels: Record<RowErrorCode, string> = {
  identifiant_manquant: "Identifiant manquant",
  identifiant_en_double: "Identifiant déjà utilisé plus haut",
  titre_manquant: "Titre manquant",
  description_manquante: "Description manquante",
  texte_trop_long: "Texte anormalement long",
};

export const rowWarningLabels: Record<RowWarningCode, string> = {
  theme_manquant: "Thème non renseigné",
  site_manquant: "Site non renseigné",
  direction_manquante: "Direction non renseignée",
  auteur_manquant: "Auteur non renseigné",
  description_courte: "Description très courte",
  cellule_formule: "Cellule ressemblant à une formule (conservée comme texte)",
  budget_absent: "Budget non renseigné",
  budget_non_chiffre: "Budget non chiffré",
  budget_avec_commentaire: "Budget accompagné d'un commentaire",
  budget_ambigu: "Budget donné sous forme de fourchette",
  date_manquante: "Date de dépôt manquante",
  date_invalide: "Date de dépôt illisible",
  date_reformatee: "Date convertie au format standard",
};

// ---------- Notation par les agents ----------

export const evaluationErrorMessages: Record<import("./scoringData").EvaluationRequestError, string> = {
  non_connecte: "Votre session a expiré. Reconnectez-vous puis relancez l'évaluation.",
  idee_introuvable: "Cette idée n'existe plus ou ne vous est pas accessible.",
  evaluation_en_cours: "Une évaluation de cette idée est déjà en cours. Patientez une minute puis rechargez la page.",
  trop_de_demandes:
    "Vous avez lancé beaucoup d'évaluations en une heure : la limite est atteinte pour protéger le budget. Réessayez dans quelques minutes.",
  evaluation_echouee: "L'évaluation n'a pas abouti ; aucune note n'a été enregistrée. Relancez-la.",
  service_non_configure:
    "L'évaluation par les agents n'est pas encore configurée sur ce serveur (clé du fournisseur d'IA manquante). Contactez l'administrateur.",
  cle_invalide: "La clé du fournisseur d'IA est refusée. Contactez l'administrateur de la plateforme.",
  credit_insuffisant: "Le crédit du fournisseur d'IA est épuisé. Contactez l'administrateur de la plateforme.",
  modele_indisponible: "Le modèle d'IA configuré n'est plus disponible. Contactez l'administrateur de la plateforme.",
  quota_depasse:
    "Le fournisseur d'IA est saturé malgré plusieurs tentatives espacées. Réessayez dans quelques minutes.",
  delai_depasse: "L'analyse a pris trop de temps. Réessayez ; si le problème persiste, contactez l'administrateur.",
  reponse_invalide: "Un agent a rendu une analyse incomplète ; aucune note n'a été enregistrée. Relancez l'évaluation.",
  reseau: "Connexion au serveur impossible. Vérifiez votre accès à Internet puis réessayez.",
  inconnue: "Une erreur inattendue s'est produite. Réessayez dans quelques instants.",
};

export const recommendationLabels = {
  retenir: "À retenir pour la shortlist",
  a_discuter: "À discuter",
  ecarter: "À écarter",
} as const;

export const confidenceLabels: Record<string, string> = { faible: "faible", moyenne: "moyenne", elevee: "élevée" };

export const estimableFieldLabels: Record<string, string> = {
  budget: "Budget",
  benefices_attendus: "Bénéfices attendus",
  theme: "Thème",
  direction: "Direction",
  site: "Site",
};
