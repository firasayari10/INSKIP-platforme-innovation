import { Check, ExternalLink, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { weightedAverage } from "@/domain/scoring";
import { useAuth } from "@/features/auth/AuthProvider";
import { useLoader } from "@/hooks/useLoader";
import {
  confidenceLabels,
  dataErrorMessages,
  estimableFieldLabels,
  evaluationErrorMessages,
  recommendationLabels,
} from "@/lib/messages";
import {
  evaluateAndWait,
  getIdeaScoring,
  removeHumanScore,
  saveHumanScore,
  type Assessment,
  type Criterion,
  type Estimate,
  type Evaluation,
  type HumanScore,
  type Source,
} from "@/lib/scoringData";
import { cn } from "@/lib/utils";

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" });

const AGENT_STEPS = [
  "L'analyste estime les données manquantes",
  "Quatre consultants évaluent chacun un critère, avec recherche web",
  "L'associé senior rédige la synthèse et la recommandation",
];

export function EvaluationPanel({ challengeId, ideaId }: { challengeId: string; ideaId: string }) {
  const { client, state } = useAuth();
  const scoring = useLoader(() => getIdeaScoring(client, challengeId, ideaId), [client, challengeId, ideaId]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const mounted = useRef(true);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return setElapsed(0);
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => () => void (mounted.current = false), []);

  // Évaluation lancée ailleurs (lot, autre onglet) : on suit son avancement.
  const runningElsewhere =
    !running && scoring.state.status === "ready" && scoring.state.data.evaluation?.status === "running";
  useEffect(() => {
    if (!runningElsewhere) return;
    const t = setInterval(scoring.reload, 5_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningElsewhere]);

  const run = async (force: boolean) => {
    if (running || state.status !== "authenticated") return;
    setRunning(true);
    setRunError(null);
    const result = await evaluateAndWait(client, state.session.access_token, ideaId, force, () => !mounted.current);
    if (!mounted.current) return;
    setRunning(false);
    if (!result.ok) setRunError(evaluationErrorMessages[result.error]);
    scoring.reload();
  };

  // Notation automatique : une idée jamais évaluée l'est dès l'ouverture de sa fiche, sans
  // renseignement préalable (contexte client supposé par défaut). Jamais relancée seule après
  // un échec, et une seule fois par visite, pour ne pas multiplier les appels payants.
  const autoStarted = useRef(false);
  const neverEvaluated = scoring.state.status === "ready" && scoring.state.data.evaluation === null;
  useEffect(() => {
    if (!neverEvaluated || autoStarted.current) return;
    autoStarted.current = true;
    void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neverEvaluated]);

  return (
    <section className="space-y-4 rounded-lg border bg-background p-5 text-sm" aria-labelledby="evaluation-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="evaluation-title" className="text-base font-semibold">
            Évaluation
          </h2>
          <p className="text-muted-foreground">
            Une équipe d'agents propose une note argumentée par critère ; vous validez la note finale.
          </p>
        </div>
        {scoring.state.status === "ready" && (
          <Button
            onClick={() => void run(scoring.state.status === "ready" && scoring.state.data.evaluation?.status === "completed")}
            disabled={running}
            variant={scoring.state.data.evaluation ? "outline" : "default"}
          >
            {running ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
            ) : scoring.state.data.evaluation ? (
              <RefreshCw className="size-4" aria-hidden />
            ) : (
              <Sparkles className="size-4" aria-hidden />
            )}
            {running ? "Analyse en cours…" : scoring.state.data.evaluation ? "Relancer l'évaluation" : "Lancer l'évaluation"}
          </Button>
        )}
      </div>

      {running && (
        <Alert tone="info" title={`Les agents analysent l'idée… ${formatElapsed(elapsed)} (2 à 5 minutes selon la charge du fournisseur d'IA)`}>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5">
            {AGENT_STEPS.map(s => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </Alert>
      )}
      {runError && <Alert tone="error">{runError}</Alert>}

      {scoring.state.status === "loading" && <p className="text-muted-foreground">Chargement de l'évaluation…</p>}
      {scoring.state.status === "error" && (
        <Alert tone="error">{dataErrorMessages[scoring.state.error]}</Alert>
      )}
      {scoring.state.status === "ready" && !(running && scoring.state.data.evaluation?.status !== "completed") && (
        <EvaluationBody
          challengeId={challengeId}
          ideaId={ideaId}
          criteria={scoring.state.data.criteria}
          evaluation={scoring.state.data.evaluation}
          scores={scoring.state.data.scores}
          onChanged={scoring.reload}
        />
      )}
    </section>
  );
}

function EvaluationBody({
  challengeId,
  ideaId,
  criteria,
  evaluation,
  scores,
  onChanged,
}: {
  challengeId: string;
  ideaId: string;
  criteria: Criterion[];
  evaluation: Evaluation | null;
  scores: HumanScore[];
  onChanged: () => void;
}) {
  const finalScore = weightedAverage(
    criteria.map(c => ({ weight: c.weight, score: scores.find(s => s.criterion_id === c.id)?.final_score ?? null })),
  );

  if (!evaluation) {
    return (
      <div className="rounded-md border border-dashed p-4 text-muted-foreground">
        <p className="font-medium text-foreground">Cette idée n'a pas encore été évaluée.</p>
        <p className="mt-1">
          Les agents vont : {AGENT_STEPS.map(s => s.charAt(0).toLowerCase() + s.slice(1)).join(" ; ")}. Les sources consultées
          sont citées et vérifiables.
        </p>
      </div>
    );
  }
  if (evaluation.status === "running") {
    return (
      <Alert tone="info">Une évaluation est en cours ; cette section se mettra à jour automatiquement.</Alert>
    );
  }
  if (evaluation.status === "failed") {
    return (
      <Alert tone="error" title="La dernière évaluation n'a pas abouti">
        {failureReason(evaluation.error_code)} Aucune note n'a été enregistrée.
        <span className="mt-1 block text-xs opacity-80">
          Tentative du {dateTime.format(new Date(evaluation.created_at))} · code « {evaluation.error_code ?? "inconnu"} » ·
          modèles : {Object.values(evaluation.models).join(", ")}
        </span>
      </Alert>
    );
  }

  const synthesis = evaluation.synthesis!;
  const byCriterion = new Map(evaluation.criterion_assessments.map(a => [a.criterion_id, a]));

  return (
    <div className="space-y-6">
      {/* Synthèse de l'associé */}
      <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="space-y-3 rounded-md bg-muted/50 p-4">
          <ScoreLine label="Note proposée par les agents" value={synthesis.note_globale_ia} ai />
          <ScoreLine label="Note validée" value={finalScore} />
          {finalScore === null && (
            <p className="text-xs text-muted-foreground">
              Validez chaque critère pour obtenir la note finale ({scores.length}/{criteria.length}).
            </p>
          )}
          <p
            className={cn(
              "rounded-md px-2.5 py-1.5 text-center text-xs font-medium",
              synthesis.recommandation === "retenir" && "bg-emerald-50 text-emerald-800",
              synthesis.recommandation === "a_discuter" && "bg-amber-50 text-amber-800",
              synthesis.recommandation === "ecarter" && "bg-red-50 text-red-800",
            )}
          >
            {recommendationLabels[synthesis.recommandation]}
          </p>
        </div>
        <div className="space-y-3">
          <h3 className="font-semibold">Synthèse de l'associé senior</h3>
          <p className="whitespace-pre-line leading-relaxed">{synthesis.synthese}</p>
          <p className="leading-relaxed">
            <span className="font-medium">Recommandation : </span>
            {synthesis.justification_recommandation}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <BulletList title="Points forts" items={synthesis.points_forts} />
            <BulletList title="Points faibles" items={synthesis.points_faibles} />
            <BulletList title="Incohérences relevées" items={synthesis.incoherences} />
            <BulletList title="Prochaines étapes" items={synthesis.prochaines_etapes} />
          </div>
        </div>
      </div>

      {evaluation.estimates.length > 0 && <Estimates estimates={evaluation.estimates} />}

      {/* Un bloc par critère */}
      <div className="space-y-4">
        <h3 className="font-semibold">Détail par critère</h3>
        {criteria.map(c => (
          <CriterionCard
            key={c.id}
            challengeId={challengeId}
            ideaId={ideaId}
            criterion={c}
            assessment={byCriterion.get(c.id) ?? null}
            score={scores.find(s => s.criterion_id === c.id) ?? null}
            onChanged={onChanged}
          />
        ))}
      </div>

      <p className="border-t pt-3 text-xs text-muted-foreground">
        Évaluation du {dateTime.format(new Date(evaluation.completed_at ?? evaluation.created_at))} · version des consignes{" "}
        {evaluation.prompt_version} · {evaluation.web_sources_count} source{evaluation.web_sources_count > 1 ? "s" : ""} web vérifiée
        {evaluation.web_sources_count > 1 ? "s" : ""}
        {typeof evaluation.usage.costUsd === "number" && ` · coût ${evaluation.usage.costUsd.toFixed(3)} $`} · modèles :{" "}
        {Object.entries(evaluation.models)
          .map(([agent, model]) => `${agent} ${model}`)
          .join(", ")}
      </p>
    </div>
  );
}

function ScoreLine({ label, value, ai = false }: { label: string; value: number | null; ai?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("text-2xl font-semibold tabular-nums", ai && "text-muted-foreground")}>
        {value === null ? "—" : value.toLocaleString("fr-FR", { minimumFractionDigits: 1 })}
        <span className="text-sm font-normal text-muted-foreground"> / 5</span>
      </p>
    </div>
  );
}

function BulletList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="list-disc space-y-1 pl-5">
        {items.map(i => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

function Estimates({ estimates }: { estimates: Estimate[] }) {
  return (
    <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50/50 p-4">
      <div>
        <h3 className="font-semibold">Données estimées par l'analyste</h3>
        <p className="text-xs text-muted-foreground">
          Ces valeurs ne figurent pas dans le fichier importé : ce sont des estimations raisonnées, à confirmer avec le
          porteur de l'idée. Les données d'origine ne sont pas modifiées.
        </p>
      </div>
      <ul className="space-y-3">
        {estimates.map(e => (
          <li key={e.field} className="space-y-1">
            <p>
              <span className="font-medium">{estimableFieldLabels[e.field] ?? e.field} : </span>
              {e.rangeMinEur !== null && e.rangeMaxEur !== null
                ? `${euro.format(e.rangeMinEur)} à ${euro.format(e.rangeMaxEur)}`
                : e.value}
              <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                Estimation · confiance {confidenceLabels[e.confidence] ?? e.confidence}
              </span>
            </p>
            <p className="text-muted-foreground">Méthode : {e.method}</p>
            {e.assumptions.length > 0 && (
              <p className="text-muted-foreground">Hypothèses : {e.assumptions.join(" ; ")}</p>
            )}
            <SourceList sources={e.sources} rejected={e.rejectedSources} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CriterionCard({
  challengeId,
  ideaId,
  criterion,
  assessment,
  score,
  onChanged,
}: {
  challengeId: string;
  ideaId: string;
  criterion: Criterion;
  assessment: Assessment | null;
  score: HumanScore | null;
  onChanged: () => void;
}) {
  return (
    <article className="space-y-3 rounded-md border p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-semibold">
          {criterion.label}
          {criterion.weight !== 1 && <span className="ml-2 text-xs font-normal text-muted-foreground">poids {criterion.weight}</span>}
        </h4>
        {assessment && (
          <span className="rounded-md border border-dashed px-2 py-0.5 text-xs text-muted-foreground">
            Proposition des agents : <strong className="text-foreground">{assessment.ai_score} / 5</strong> · confiance{" "}
            {confidenceLabels[assessment.details.confiance] ?? assessment.details.confiance}
          </span>
        )}
      </header>

      {assessment ? (
        <>
          <p className="leading-relaxed">{assessment.summary}</p>
          <details className="group rounded-md bg-muted/40 px-3 py-2">
            <summary className="cursor-pointer select-none font-medium">Voir l'analyse détaillée et les sources</summary>
            <AssessmentDetails assessment={assessment} />
          </details>
        </>
      ) : (
        <p className="text-muted-foreground">Pas d'analyse des agents pour ce critère.</p>
      )}

      <HumanScoreEditor
        challengeId={challengeId}
        ideaId={ideaId}
        criterionId={criterion.id}
        assessment={assessment}
        score={score}
        onChanged={onChanged}
      />
    </article>
  );
}

function AssessmentDetails({ assessment }: { assessment: Assessment }) {
  const d = assessment.details;
  return (
    <div className="mt-3 space-y-4">
      <table className="w-full text-left">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="pb-1 font-medium">Sous-critère</th>
            <th className="pb-1 text-right font-medium">Note</th>
            <th className="pb-1 pl-3 font-medium">Commentaire</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {d.sous_criteres.map(s => (
            <tr key={s.nom}>
              <td className="py-1.5 pr-2 align-top font-medium">{s.nom}</td>
              <td className="py-1.5 text-right align-top tabular-nums">{s.note}/5</td>
              <td className="py-1.5 pl-3 align-top text-muted-foreground">{s.commentaire}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid gap-3 sm:grid-cols-2">
        <BulletList title="Arguments pour" items={d.arguments_pour} />
        <BulletList title="Arguments contre" items={d.arguments_contre} />
        <BulletList title="Hypothèses retenues" items={d.hypotheses} />
        <BulletList title="Données qui manqueraient pour conclure" items={d.donnees_manquantes} />
      </div>
      <SourceList sources={assessment.sources} rejected={d.sources_rejetees ?? 0} />
      <p className="text-xs text-muted-foreground">Analyse produite par {assessment.model}.</p>
    </div>
  );
}

const isWebUrl = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

function SourceList({ sources, rejected }: { sources: Source[]; rejected: number }) {
  const safe = sources.filter(s => isWebUrl(s.url));
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">Sources consultées</p>
      {safe.length === 0 ? (
        <p className="text-xs text-muted-foreground">Aucune source web vérifiée : l'analyse repose sur le raisonnement de l'agent.</p>
      ) : (
        <ul className="space-y-1">
          {safe.map(s => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-baseline gap-1 underline-offset-2 hover:underline">
                {s.title}
                <ExternalLink className="size-3 shrink-0 self-center" aria-hidden />
                <span className="sr-only">(nouvel onglet)</span>
              </a>
              <span className="text-muted-foreground"> — {s.excerpt}</span>
            </li>
          ))}
        </ul>
      )}
      {rejected > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          {rejected} référence{rejected > 1 ? "s" : ""} citée{rejected > 1 ? "s" : ""} par l'agent mais introuvable
          {rejected > 1 ? "s" : ""} dans sa recherche : écartée{rejected > 1 ? "s" : ""}.
        </p>
      )}
    </div>
  );
}

function HumanScoreEditor({
  challengeId,
  ideaId,
  criterionId,
  assessment,
  score,
  onChanged,
}: {
  challengeId: string;
  ideaId: string;
  criterionId: string;
  assessment: Assessment | null;
  score: HumanScore | null;
  onChanged: () => void;
}) {
  const { client } = useAuth();
  const [editing, setEditing] = useState(score === null);
  const [value, setValue] = useState<number | null>(score?.final_score ?? assessment?.ai_score ?? null);
  const [comment, setComment] = useState(score?.final_comment ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (value === null || pending) return;
    setPending(true);
    setError(null);
    const r = await saveHumanScore(client, {
      challengeId,
      ideaId,
      criterionId,
      score: value,
      comment,
      assessmentId: assessment?.id ?? null,
    });
    setPending(false);
    if (!r.ok) return setError(dataErrorMessages[r.error]);
    setEditing(false);
    onChanged();
  };

  const remove = async () => {
    setPending(true);
    const r = await removeHumanScore(client, ideaId, criterionId);
    setPending(false);
    if (!r.ok) return setError(dataErrorMessages[r.error]);
    setEditing(true);
    onChanged();
  };

  if (score && !editing) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-emerald-50 px-3 py-2">
        <p className="text-emerald-900">
          <Check className="mr-1 inline size-4" aria-hidden />
          Note validée : <strong>{score.final_score} / 5</strong>
          {score.final_comment && <span className="text-emerald-800"> — {score.final_comment}</span>}
        </p>
        <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
          Modifier
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border-t pt-3">
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Votre note</legend>
        {[1, 2, 3, 4, 5].map(n => (
          <Button
            key={n}
            type="button"
            size="sm"
            variant={value === n ? "default" : "outline"}
            aria-pressed={value === n}
            onClick={() => setValue(n)}
            className="w-9"
          >
            {n}
          </Button>
        ))}
        {assessment && value !== assessment.ai_score && (
          <span className="text-xs text-muted-foreground">(proposition des agents : {assessment.ai_score})</span>
        )}
      </fieldset>
      <textarea
        value={comment}
        onChange={e => setComment(e.target.value.slice(0, 2000))}
        rows={2}
        placeholder="Commentaire (facultatif) : pourquoi vous confirmez ou corrigez la note"
        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        aria-label="Commentaire sur la note"
      />
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={save} disabled={value === null || pending}>
          {pending && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
          Valider la note
        </Button>
        {score && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={pending}>
              Annuler
            </Button>
            <Button size="sm" variant="ghost" onClick={remove} disabled={pending}>
              Retirer la validation
            </Button>
          </>
        )}
      </div>
    </div>
  );
}


function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const sec = String(seconds % 60).padStart(2, "0");
  return `${m} min ${sec} s`;
}

/** Raison lisible d'un échec enregistré (code générique du serveur). */
function failureReason(code: string | null): string {
  if (code === "abandonnee") return "L'évaluation a été interrompue (serveur redémarré ou délai dépassé).";
  if (code === "aucun_critere") return "La grille de critères de ce challenge est vide.";
  if (code === "erreur_interne" || code === "enregistrement_impossible")
    return "Une erreur interne s'est produite pendant l'enregistrement.";
  if (code && code in evaluationErrorMessages)
    return evaluationErrorMessages[code as keyof typeof evaluationErrorMessages];
  return "Cause inconnue.";
}
