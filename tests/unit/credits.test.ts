import { describe, expect, test } from "bun:test";
import {
  costMicroEur,
  creditLevel,
  formatEuros,
  parsePriceTable,
  reservationMicroEur,
  totalMicroEur,
  usageEvent,
} from "@/domain/credits";

const fallback = { input: 1, output: 4 };
const table = parsePriceTable('{"modele-a":{"input":0.5,"output":2}}', fallback);

describe("barème", () => {
  test("prix par modèle, repli pour un modèle absent", () => {
    expect(costMicroEur(table, "modele-a", 1_000_000, 0)).toBe(500_000); // 0,50 €
    expect(costMicroEur(table, "inconnu", 0, 1_000_000)).toBe(4_000_000); // 4 €
  });

  test("barème invalide ou absent : repli sur le barème par défaut", () => {
    for (const raw of [undefined, "", "pas du json", '{"m":{"input":-1,"output":2}}']) {
      expect(parsePriceTable(raw, fallback)).toEqual({ models: {}, fallback });
    }
  });

  test("arrondi au micro-euro supérieur : jamais de sous-facturation", () => {
    const t = parsePriceTable('{"m":{"input":0.3,"output":0}}', fallback);
    expect(costMicroEur(t, "m", 1, 0)).toBe(1); // 0,3 µ€ → 1 µ€
    expect(costMicroEur(t, "m", 0, 0)).toBe(0);
  });

  test("jetons négatifs ou fractionnaires ramenés à des entiers positifs", () => {
    expect(costMicroEur(table, "modele-a", -50, 10.9)).toBe(20);
  });
});

describe("réservation pessimiste", () => {
  test("couvre le plafond de sortie, les pages web et une marge de 20 %", () => {
    const amount = reservationMicroEur(table, [{ model: "modele-a", inputChars: 3_000, maxOutputTokens: 1_000, webResults: 2 }]);
    // entrée : 1 000 + 2 × 800 = 2 600 jetons × 0,5 = 1 300 µ€ ; sortie : 1 000 × 2 = 2 000 µ€ ; × 1,2
    expect(amount).toBe(Math.ceil(3_300 * 1.2));
  });

  test("au moins 1 µ€", () => {
    expect(reservationMicroEur(table, [])).toBe(1);
  });

  test("une évaluation complète (6 appels) est réservée plus cher qu'un message de discussion", () => {
    const call = { model: "modele-a", inputChars: 8_000, maxOutputTokens: 4_096, webResults: 5 };
    expect(reservationMicroEur(table, Array(6).fill(call))).toBeGreaterThan(reservationMicroEur(table, [{ ...call, webResults: 0 }]));
  });
});

describe("événements d'usage", () => {
  test("coût calculé par appel et total exact", () => {
    const events = [usageEvent(table, "consultant_impact", "modele-a", 2_000, 500, 5), usageEvent(table, "associe", "inconnu", 1_000, 1_000)];
    expect(events[0]).toEqual({ agent: "consultant_impact", model: "modele-a", input_tokens: 2_000, output_tokens: 500, cost_micro_eur: 2_000, web_searches: 5 });
    expect(totalMicroEur(events)).toBe(2_000 + 5_000);
  });
});

describe("affichage", () => {
  test("format en euros", () => {
    expect(formatEuros(5_000_000).replace(/\s/g, " ")).toBe("5,00 €");
    expect(formatEuros(3_421_000).replace(/\s/g, " ")).toBe("3,42 €");
  });

  test("niveau : alerte à 80 % consommés, épuisé à 0", () => {
    expect(creditLevel(5_000_000, 2_000_000)).toBe("ok");
    expect(creditLevel(5_000_000, 1_000_000)).toBe("attention");
    expect(creditLevel(5_000_000, 0)).toBe("epuise");
    expect(creditLevel(5_000_000, -10)).toBe("epuise");
  });
});
