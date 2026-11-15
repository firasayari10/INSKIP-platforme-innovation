/**
 * Serveur de développement local uniquement (HMR). En production, Vercel sert le build
 * statique de `dist/` et les fonctions de `api/` (CLAUDE.md §3).
 */
import { serve } from "bun";
import index from "./index.html";

const server = serve({
  routes: {
    // Application monopage : toutes les routes renvoient index.html.
    "/*": index,
  },
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Serveur de développement : ${server.url}`);
