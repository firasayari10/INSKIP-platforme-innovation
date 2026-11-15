/**
 * Préchargé par `bun test` (bunfig.toml) : interdit tout appel réseau sortant pendant les tests.
 * Aucun test ne doit consommer un vrai fournisseur d'IA ni joindre Supabase ; les tests injectent
 * un transport simulé. Seules les adresses locales restent permises.
 */
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return realFetch(input, init);
  throw new Error(`Appel réseau interdit pendant les tests : ${url.hostname}`);
}) as typeof fetch;
