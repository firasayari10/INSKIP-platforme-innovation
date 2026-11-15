/**
 * Vercel Function : POST /api/evaluate-idea (logique dans src/server/evaluateHandler.ts).
 * Seul point d'entrée qui lit les clés d'IA et SUPABASE_SECRET_KEY.
 * `waitUntil` garde l'instance en vie jusqu'à la fin de l'évaluation lancée en arrière-plan
 * (sans lui, la plateforme peut l'arrêter juste après la réponse 202 — ADR 0003, défaut D3).
 */
import { waitUntil } from "@vercel/functions";
import { handleEvaluateIdea } from "../src/server/evaluateHandler";

export function POST(request: Request): Promise<Response> {
  return handleEvaluateIdea(request, process.env, { background: waitUntil });
}
