import Papa from "papaparse";
import type { CsvTable } from "@/domain/importAnalysis";
import { err, ok, type Result } from "@/domain/result";

/** Taille maximale d'un fichier importé (protection du navigateur). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export type CsvError = "fichier_trop_volumineux" | "format_non_supporte" | "lecture_impossible" | "fichier_vide";

export function checkFile(file: { name: string; size: number }): Result<true, CsvError> {
  if (!/\.csv$/i.test(file.name)) return err("format_non_supporte");
  if (file.size === 0) return err("fichier_vide");
  if (file.size > MAX_FILE_BYTES) return err("fichier_trop_volumineux");
  return ok(true);
}

/**
 * Lit un CSV (séparateur `;` ou `,` détecté automatiquement, BOM et CRLF tolérés).
 * Aucune formule n'est évaluée : chaque cellule reste du texte brut.
 */
export function parseCsvText(text: string): Result<CsvTable, CsvError> {
  const content = text.replace(/^﻿/, "");
  if (content.trim() === "") return err("fichier_vide");

  const parsed = Papa.parse<string[]>(content, {
    delimiter: "", // détection automatique
    delimitersToGuess: [";", ",", "\t"],
    skipEmptyLines: false,
    dynamicTyping: false,
  });

  // Une erreur de guillemets non fermés rend la lecture peu fiable : on refuse le fichier.
  if (parsed.errors.some(e => e.type === "Quotes")) return err("lecture_impossible");

  const [headers = [], ...rows] = parsed.data;
  // La dernière ligne vide due au retour à la ligne final n'est pas une « ligne vide » du fichier.
  while (rows.length > 0 && rows.at(-1)!.length === 1 && rows.at(-1)![0] === "") rows.pop();
  return ok({ headers, rows });
}
