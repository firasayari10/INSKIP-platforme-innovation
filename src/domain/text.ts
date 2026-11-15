/**
 * Normalisation de texte français pour la comparaison (doublons, empreinte de contenu).
 * Pur et déterministe.
 */

/** Mots vides français fréquents : ils n'apportent rien à la comparaison de deux idées. */
const STOPWORDS = new Set(
  (
    "a afin ai aie aient ainsi alors au aucun aussi autre aux avec avoir avant c ca car ce ceci cela celle celles " +
    "celui ces cet cette chaque chez ci comme comment d dans de des deja depuis donc dont du elle elles en encore " +
    "entre est et etc etre eu fait faire faut il ils j je jusqu l la le les leur leurs lui m ma mais me meme mes " +
    "moi moins mon n ne ni nos notre nous on ont ou par pas peu peut plus pour pouvoir qu quand que quel quelle " +
    "quelles quels qui quoi s sa sans se ses si son sont souvent sous sur t ta te tes toi ton tous tout toute " +
    "toutes tres trop un une unes uns vers via voir vos votre vous y aujourd hui deux trois chacun prend " +
    "the of and to for in on with"
  ).split(" "),
);

/** Minuscules, sans accents, sans ponctuation, espaces simples. */
export function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Racinisation légère : pluriels et quelques suffixes courants (« compresseurs » → « compresseur »). */
function stem(word: string): string {
  let w = word;
  if (w.length > 4 && (w.endsWith("s") || w.endsWith("x"))) w = w.slice(0, -1);
  if (w.length > 6 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** Mots significatifs d'un texte, racinisés, sans mots vides ni nombres isolés. */
export function significantTokens(input: string): string[] {
  return normalizeText(input)
    .split(" ")
    .filter(t => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .map(stem);
}

/** Clé de contenu : deux idées au contenu identique (à la casse, aux accents et à la ponctuation près) ont la même clé. */
export function contentKey(title: string, description: string): string {
  return `${normalizeText(title)}\n${normalizeText(description)}`;
}
