/**
 * Vercel Function : POST /api/idea-chat (logique dans src/server/chatHandler.ts).
 */
import { handleIdeaChat } from "../src/server/chatHandler";

export function POST(request: Request): Promise<Response> {
  return handleIdeaChat(request, process.env);
}
