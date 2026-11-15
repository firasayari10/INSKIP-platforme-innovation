import { Coins, LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { creditLevel, formatEuros } from "@/domain/credits";
import { useAuth } from "@/features/auth/AuthProvider";
import { useLoader } from "@/hooks/useLoader";
import { dataErrorMessages } from "@/lib/messages";
import { getMyCredit, listMyUsage, type UsageRow } from "@/lib/scoringData";
import { cn } from "@/lib/utils";

const AGENT_LABELS: Record<string, string> = {
  analyste: "Analyste",
  associe: "Associé senior",
  conversation: "Discussion",
};
const agentLabel = (agent: string | null) =>
  !agent ? "—" : (AGENT_LABELS[agent] ?? (agent.startsWith("consultant_") ? `Consultant ${agent.slice(11)}` : agent));
const dateTime = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const monthName = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });

/** Indicateur de crédits IA dans l'en-tête : restant du mois, détail et dernières consommations. */
export function CreditBadge() {
  const id = useId();
  const { client } = useAuth();
  const credit = useLoader(() => getMyCredit(client), [client]);
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  // Rafraîchi après chaque évaluation / message, et toutes les minutes.
  useEffect(() => {
    const refresh = () => credit.reload();
    window.addEventListener("ai-credit-changed", refresh);
    const t = setInterval(refresh, 60_000);
    return () => {
      window.removeEventListener("ai-credit-changed", refresh);
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  if (credit.state.status === "loading")
    return <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="Chargement des crédits IA" />;
  if (credit.state.status === "error") return null; // l'en-tête reste utilisable sans l'indicateur

  const c = credit.state.data;
  const available = c.allocation_micro_eur + c.granted_micro_eur;
  const level = creditLevel(available, c.remaining_micro_eur);
  const usedPercent = available > 0 ? Math.min(100, Math.round(((available - Math.max(0, c.remaining_micro_eur)) / available) * 100)) : 100;

  return (
    <div ref={wrapper} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        className={cn(
          "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm tabular-nums",
          level === "ok" && "border-border text-foreground",
          level === "attention" && "border-amber-300 bg-amber-50 text-amber-900",
          level === "epuise" && "border-red-300 bg-red-50 text-red-800",
        )}
        title="Crédit IA du mois"
      >
        <Coins className="size-4" aria-hidden />
        {level === "epuise" ? "Crédit IA épuisé" : `${formatEuros(Math.max(0, c.remaining_micro_eur))}`}
        <span className="sr-only"> restants sur votre crédit IA du mois</span>
      </button>

      {open && (
        <div
          id={`${id}-panel`}
          className="absolute right-0 top-full z-50 mt-2 w-80 space-y-3 rounded-lg border bg-popover p-4 text-sm shadow-lg"
        >
          <div>
            <p className="font-semibold">Crédit IA — {monthName.format(new Date(`${c.month}T00:00:00`))}</p>
            <p className="text-xs text-muted-foreground">Remis à {formatEuros(c.allocation_micro_eur)} le 1er de chaque mois.</p>
          </div>
          <div className="space-y-1">
            <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div
                className={cn("h-full", level === "ok" ? "bg-primary" : level === "attention" ? "bg-amber-500" : "bg-red-500")}
                style={{ width: `${usedPercent}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">{usedPercent} % utilisés</p>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Restant</dt>
            <dd className="text-right font-medium tabular-nums">{formatEuros(Math.max(0, c.remaining_micro_eur))}</dd>
            <dt className="text-muted-foreground">Consommé</dt>
            <dd className="text-right tabular-nums">{formatEuros(c.consumed_micro_eur)}</dd>
            {c.reserved_micro_eur > 0 && (
              <>
                <dt className="text-muted-foreground">Réservé (en cours)</dt>
                <dd className="text-right tabular-nums">{formatEuros(c.reserved_micro_eur)}</dd>
              </>
            )}
            {c.granted_micro_eur > 0 && (
              <>
                <dt className="text-muted-foreground">Recrédité</dt>
                <dd className="text-right tabular-nums">{formatEuros(c.granted_micro_eur)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Évaluations</dt>
            <dd className="text-right tabular-nums">{c.evaluations_count}</dd>
            <dt className="text-muted-foreground">Messages de discussion</dt>
            <dd className="text-right tabular-nums">{c.discussion_messages_count}</dd>
          </dl>
          {level !== "ok" && (
            <p className={cn("rounded-md px-2 py-1.5 text-xs", level === "attention" ? "bg-amber-50 text-amber-900" : "bg-red-50 text-red-800")}>
              {level === "attention"
                ? "Plus de 80 % de votre crédit du mois est utilisé."
                : "Crédit épuisé : l'IA ne peut plus être appelée ce mois-ci. Contactez l'administrateur pour un recrédit."}
            </p>
          )}
          <RecentUsage />
        </div>
      )}
    </div>
  );
}

function RecentUsage() {
  const { client } = useAuth();
  const usage = useLoader(() => listMyUsage(client, 12), [client]);
  if (usage.state.status === "loading") return <p className="text-xs text-muted-foreground">Chargement du détail…</p>;
  if (usage.state.status === "error") return <p className="text-xs text-destructive">{dataErrorMessages[usage.state.error]}</p>;
  if (usage.state.data.length === 0) return <p className="text-xs text-muted-foreground">Aucune consommation ce mois-ci.</p>;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">Dernières consommations</p>
      <ul className="max-h-48 divide-y overflow-y-auto text-xs">
        {usage.state.data.map((u: UsageRow) => (
          <li key={u.id} className="flex items-baseline justify-between gap-2 py-1">
            <span className="min-w-0 truncate">
              <span className="tabular-nums text-muted-foreground">{dateTime.format(new Date(u.created_at))}</span>{" "}
              {u.kind === "grant" ? "Recrédit" : `${u.operation === "discussion" ? "Discussion" : "Évaluation"} · ${agentLabel(u.agent)}`}
            </span>
            <span className={cn("shrink-0 tabular-nums", u.kind === "grant" && "text-emerald-700")}>
              {u.kind === "grant" ? "+" : "−"}
              {formatEuros(u.amount_micro_eur)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
