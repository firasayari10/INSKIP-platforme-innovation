import { describe, expect, test } from "bun:test";
import { createPseudonymizer } from "@/domain/pseudonymize";

const authors = [
  { firstName: "Julie", lastName: "Marchand" },
  { firstName: "Thomas", lastName: "Lefèvre" },
  { firstName: "Karim", lastName: "Haddad" },
  { firstName: "Rose", lastName: null },
];

describe("noms des personnes", () => {
  test("remplace le nom complet et le nom seul par un jeton stable", () => {
    const p = createPseudonymizer(authors);
    expect(p.text("Idée proposée par Julie Marchand. Marchand a déjà piloté un projet.")).toBe(
      "Idée proposée par [PERSONNE_1]. [PERSONNE_1] a déjà piloté un projet.",
    );
  });

  test("ordre inversé, casse et accents différents", () => {
    const p = createPseudonymizer(authors);
    expect(p.text("Contact : MARCHAND Julie, ou thomas lefevre")).toBe("Contact : [PERSONNE_1], ou [PERSONNE_2]");
  });

  test("chaque personne garde le même jeton d'un texte à l'autre", () => {
    const p = createPseudonymizer(authors);
    p.text("Karim Haddad");
    expect(p.text("Avis de Lefèvre puis de Haddad")).toBe("Avis de [PERSONNE_2] puis de [PERSONNE_1]");
  });

  test("ne remplace pas un nom à l'intérieur d'un autre mot", () => {
    const p = createPseudonymizer([{ firstName: "Paul", lastName: "Hadd" }]);
    expect(p.text("Haddad et Hadd")).toBe("Haddad et [PERSONNE_1]");
  });

  test("un prénom seul n'est pas remplacé (risque de confusion avec un mot courant)", () => {
    const p = createPseudonymizer(authors);
    expect(p.text("Une Rose des vents pour Julie")).toBe("Une Rose des vents pour Julie");
  });

  test("civilité suivie d'un nom inconnu : remplacée par [PERSONNE]", () => {
    const p = createPseudonymizer([]);
    expect(p.text("Validé par M. Durand et Mme Petit-Jean, puis Madame Roux.")).toBe(
      "Validé par [PERSONNE] et [PERSONNE], puis [PERSONNE].",
    );
  });

  test("ignore les noms trop courts pour être fiables", () => {
    const p = createPseudonymizer([{ firstName: "Li", lastName: "Wu" }]);
    expect(p.text("Wu et Li")).toBe("Wu et Li");
  });
});

describe("coordonnées et identifiants", () => {
  const p = () => createPseudonymizer([]);

  test("adresses e-mail", () => {
    expect(p().text("Écrire à julie.marchand@hexavia.fr ou rh@hexavia.com")).toBe("Écrire à [EMAIL] ou [EMAIL]");
  });

  test.each(["06 12 34 56 78", "06.12.34.56.78", "+33 6 12 34 56 78", "0612345678", "+33612345678"])(
    "numéro de téléphone %p",
    phone => {
      expect(p().text(`Tél. ${phone} merci`)).toBe("Tél. [TELEPHONE] merci");
    },
  );

  test("IBAN et numéro de sécurité sociale", () => {
    expect(p().text("IBAN FR76 3000 6000 0112 3456 7890 189")).toBe("IBAN [IBAN]");
    expect(p().text("NIR 1 85 05 78 006 084 36")).toBe("NIR [NUMERO_SECU]");
  });

  test("matricule", () => {
    expect(p().text("matricule 004512, badge n° A-2231")).toBe("matricule [IDENTIFIANT], badge [IDENTIFIANT]");
  });

  test("âge d'une personne", () => {
    expect(p().text("J'ai 58 ans et 30 ans d'ancienneté")).toBe("J'ai [ÂGE] et 30 ans d'ancienneté");
  });
});

describe("ce qui ne doit PAS être modifié", () => {
  const p = () => createPseudonymizer(authors);

  test.each([
    "Budget de 40 000 € sur 12 compresseurs.",
    "Réduire de 30 % les émissions d'ici 2030.",
    "Site de Lyon, direction Maintenance, 3 jours de production par an.",
    "Norme ISO 50001 et capteurs IoT à 200 € l'unité.",
    "Retour sur investissement en 18 mois, soit 1,5 an.",
    "Voir https://exemple.fr/etude-2026",
  ])("contenu métier intact : %p", text => {
    expect(p().text(text)).toBe(text);
  });

  test("texte vide ou absent", () => {
    expect(p().text("")).toBe("");
    expect(p().maybe(null)).toBeNull();
  });
});

describe("traçabilité", () => {
  test("indique combien d'éléments ont été masqués, par catégorie", () => {
    const p = createPseudonymizer(authors);
    p.text("Julie Marchand, julie@x.fr, 06 12 34 56 78");
    p.text("Marchand");
    expect(p.report()).toEqual({ personnes: 2, emails: 1, telephones: 1, identifiants: 0 });
  });
});
