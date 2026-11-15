/**
 * Vercel Function : POST /api/evaluate-idea (logique dans src/server/evaluateHandler.ts).
 * Seul code serveur qui lit OPENROUTER_API_KEY et SUPABASE_SECRET_KEY.
 */
import { handleEvaluateIdea } from "../src/server/evaluateHandler";

export function POST(request: Request): Promise<Response> {
  return handleEvaluateIdea(request, process.env);
}
