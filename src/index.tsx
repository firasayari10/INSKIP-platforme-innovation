/**
 * Serveur de développement local uniquement (HMR). En production, Vercel sert le build
 * statique de `dist/` et les fonctions de `api/` (CLAUDE.md §3).
 */
import { serve } from "bun";
import index from "./index.html";
import { handleIdeaChat } from "./server/chatHandler";
import { handleEvaluateIdea } from "./server/evaluateHandler";

const server = serve({
  // Une réponse de l'IA peut attendre son tour dans le limiteur de débit (défaut Bun : 10 s).
  idleTimeout: 255,
  routes: {
    // Application monopage : toutes les routes renvoient index.html.
    "/*": index,
    // Même logique que la Vercel Function api/evaluate-idea.ts (Bun charge .env.local).
    "/api/evaluate-idea": { POST: req => handleEvaluateIdea(req, process.env) },
    "/api/idea-chat": { POST: req => handleIdeaChat(req, process.env) },
  },
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Serveur de développement : ${server.url}`);
