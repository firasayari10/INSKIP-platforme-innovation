import type { SupabaseClient } from "@supabase/supabase-js";
import { err, ok, type Result } from "../domain/result";
import { totalMicroEur, type UsageEvent } from "../domain/credits";

/**
 * Crédits IA côté serveur (migration credits_ia) : réservation pessimiste avant l'appel, puis
 * régularisation au coût réel (le reliquat est rendu) ou libération. Uniquement via les fonctions
 * de la base réservées à service_role : le navigateur ne peut rien écrire.
 * En cas d'incident sur les crédits, on REFUSE l'appel à l'IA (sécurité du budget).
 */

export type CreditError = "credit_ia_epuise" | "credit_indisponible";

export interface ReserveArgs {
  userId: string;
  amountMicroEur: number;
  kind: "evaluation" | "discussion";
  idempotencyKey: string;
  challengeId: string;
  ideaId?: string | null;
}

export interface CreditService {
  reserve(args: ReserveArgs): Promise<Result<string, CreditError>>;
  /** Régularise au coût réel des appels effectués ; sans appel facturable, libère la réservation. */
  settle(reservationId: string, events: UsageEvent[], evaluationId?: string | null): Promise<void>;
  release(reservationId: string): Promise<void>;
}

export function createSupabaseCredits(db: SupabaseClient): CreditService {
  const release = async (reservationId: string) => {
    const { error } = await db.rpc("release_ai_credit", { p_reservation_id: reservationId });
    if (error) console.error(`[credits] libération impossible (${reservationId.slice(0, 8)}) : ${error.code}`);
  };
  return {
    async reserve(args) {
      const { data, error } = await db.rpc("reserve_ai_credit", {
        p_user_id: args.userId,
        p_amount_micro_eur: Math.max(1, Math.ceil(args.amountMicroEur)),
        p_kind: args.kind,
        p_idempotency_key: args.idempotencyKey,
        p_challenge_id: args.challengeId,
        p_idea_id: args.ideaId ?? null,
      });
      if (error) {
        if (error.code === "CI001") return err("credit_ia_epuise");
        console.error(`[credits] réservation impossible : ${error.code}`);
        return err("credit_indisponible");
      }
      return typeof data === "string" ? ok(data) : err("credit_indisponible");
    },
    async settle(reservationId, events, evaluationId = null) {
      const total = totalMicroEur(events);
      if (events.length === 0) return release(reservationId);
      const { error } = await db.rpc("settle_ai_credit", {
        p_reservation_id: reservationId,
        p_actual_micro_eur: total,
        p_events: events.slice(0, 100),
        p_evaluation_id: evaluationId,
      });
      if (error) console.error(`[credits] régularisation impossible (${reservationId.slice(0, 8)}) : ${error.code}`);
    },
    release,
  };
}
