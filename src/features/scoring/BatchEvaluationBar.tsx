import { LoaderCircle, Sparkles, Square } from "lucide-react";
import { useRef, useState } from "react";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { ideasToEvaluate, runWithConcurrency, type BatchProgress } from "@/domain/batch";
import { useAuth } from "@/features/auth/AuthProvider";
import { evaluationErrorMessages } from "@/lib/messages";
import { evaluateAndWait, type EvaluationRequestError, type EvaluationSummary } from "@/lib/scoringData";

/**
 * Deux idées évaluées en même temps : chaque idée mobilise déjà 5 à 6 agents, et le serveur
 * limite de toute façon le débit vers le fournisseur d'IA (appels simultanés, appels par minute).
 */
const CONCURRENCY = 2;
/** Erreurs qui rendent inutile la suite du lot (configuration, crédit) : on s'arrête aussitôt. */
const FATAL: ReadonlySet<EvaluationRequestError> = new Set([
  "non_connecte",
  "service_non_configure",
  "cle_invalide",
  "credit_insuffisant",
  "modele_indisponible",
]);

export function BatchEvaluationBar({
  ideaIds,
  summaries,
  onProgress,
}: {
  ideaIds: string[];
  summaries: Map<string, EvaluationSummary>;
  onProgress: () => void;
}) {
  const { state, client } = useAuth();
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const stopRequested = useRef(false);

  const statusByIdea = new Map([...summaries].map(([id, s]) => [id, s.status]));
  const pending = ideasToEvaluate(ideaIds, statusByIdea);
  const evaluated = ideaIds.length - pending.length;

  const start = async () => {
    if (running || state.status !== "authenticated" || pending.length === 0) return;
    const token = state.session.access_token;
    stopRequested.current = false;
    setFatal(null);
    setRunning(true);
    setProgress({ done: 0, failed: 0, total: pending.length });
    await runWithConcurrency(
      pending,
      CONCURRENCY,
      async ideaId => {
        const r = await evaluateAndWait(client, token, ideaId, false);
        if (!r.ok && FATAL.has(r.error)) {
          stopRequested.current = true;
          setFatal(evaluationErrorMessages[r.error]);
        }
        return r.ok;
      },
      p => {
        setProgress(p);
        onProgress();
      },
      () => stopRequested.current,
    );
    setRunning(false);
    onProgress();
  };

  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="space-y-3 rounded-lg border bg-background p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold">Notation par les agents</p>
          <p className="text-muted-foreground">
            {evaluated} idée{evaluated > 1 ? "s" : ""} évaluée{evaluated > 1 ? "s" : ""} sur {ideaIds.length}
            {pending.length > 0 && !running && ` · ${pending.length} à évaluer (environ ${Math.ceil(pending.length * 1.5 / CONCURRENCY)} min)`}
          </p>
        </div>
        {running ? (
          <Button variant="outline" onClick={() => (stopRequested.current = true)} disabled={stopRequested.current}>
            <Square className="size-4" aria-hidden />
            {stopRequested.current ? "Arrêt après les idées en cours…" : "Arrêter"}
          </Button>
        ) : (
          pending.length > 0 && (
            <Button onClick={() => void start()}>
              <Sparkles className="size-4" aria-hidden />
              Évaluer {pending.length === ideaIds.length ? "toutes les idées" : `les ${pending.length} idées restantes`}
            </Button>
          )
        )}
      </div>

      {progress && (running || progress.done > 0) && (
        <div className="space-y-1" role="status" aria-live="polite">
          <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            {running && <LoaderCircle className="size-3 animate-spin" aria-hidden />}
            {progress.done} / {progress.total} traitée{progress.done > 1 ? "s" : ""}
            {progress.failed > 0 && ` · ${progress.failed} en échec (relancez pour réessayer)`}
            {running && " · gardez cette page ouverte"}
          </p>
        </div>
      )}
      {fatal && <Alert tone="error">{fatal}</Alert>}
    </div>
  );
}
