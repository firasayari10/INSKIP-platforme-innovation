import { ArrowLeft, FileText, FileUp, Inbox, SearchX } from "lucide-react";
import { useMemo } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/PageStates";
import { Button } from "@/components/ui/button";
import { EMPTY_FILTERS, filterIdeas, filtersFromParams, filtersToParams, type IdeaFilters } from "@/domain/ideaFilters";
import type { RowWarningCode } from "@/domain/importAnalysis";
import { useAuth } from "@/features/auth/AuthProvider";
import { useLoader } from "@/hooks/useLoader";
import { getChallenge, listDuplicateIdeaIds, listIdeas } from "@/lib/data";
import { dataErrorMessages, rowWarningLabels } from "@/lib/messages";
import { BatchEvaluationBar } from "@/features/scoring/BatchEvaluationBar";
import { ChallengeContextCard } from "@/features/scoring/ChallengeContextCard";
import { listEvaluationSummaries, type EvaluationSummary } from "@/lib/scoringData";
import { recommendationLabels } from "@/lib/messages";
import { IdeaFilterBar } from "./IdeaFilterBar";

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const NO_DUPLICATES: ReadonlySet<string> = new Set();
const dateFormat = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });

export function ChallengePage() {
  const { challengeId = "" } = useParams();
  const { client } = useAuth();
  const navigate = useNavigate();
  const challenge = useLoader(() => getChallenge(client, challengeId), [client, challengeId]);
  const ideas = useLoader(() => listIdeas(client, challengeId), [client, challengeId]);
  const duplicates = useLoader(() => listDuplicateIdeaIds(client, challengeId), [client, challengeId]);
  const summaries = useLoader(() => listEvaluationSummaries(client, challengeId), [client, challengeId]);
  const summaryOf = (ideaId: string): EvaluationSummary | undefined =>
    summaries.state.status === "ready" ? summaries.state.data.get(ideaId) : undefined;

  // Les filtres vivent dans l'adresse : ils survivent à un rechargement et se partagent par lien.
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const setFilters = (next: IdeaFilters) => setParams(filtersToParams(next), { replace: true });

  const duplicateIds = duplicates.state.status === "ready" ? duplicates.state.data : NO_DUPLICATES;
  const visible = useMemo(
    () => (ideas.state.status === "ready" ? filterIdeas(ideas.state.data, filters, duplicateIds) : []),
    [ideas.state, filters, duplicateIds],
  );

  if (challenge.state.status === "loading") return <LoadingBlock label="Chargement du challenge…" />;
  if (challenge.state.status === "error")
    return <ErrorBlock message={dataErrorMessages[challenge.state.error]} onRetry={challenge.reload} />;
  const c = challenge.state.data;

  const importLink = (
    <Button asChild>
      <Link to={`/challenges/${c.id}/import`}>
        <FileUp className="size-4" aria-hidden />
        Importer des idées
      </Link>
    </Button>
  );

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          Vos challenges
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{c.client_name}</p>
            <h1 className="text-2xl font-semibold tracking-tight">{c.title}</h1>
          </div>
          {ideas.state.status === "ready" && ideas.state.data.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link to={`/challenges/${c.id}/rapport`}>
                  <FileText className="size-4" aria-hidden />
                  Rapport pour le jury
                </Link>
              </Button>
              {importLink}
            </div>
          )}
        </div>
      </header>

      {ideas.state.status === "loading" && <LoadingBlock label="Chargement des idées…" />}
      {ideas.state.status === "error" && (
        <ErrorBlock message={dataErrorMessages[ideas.state.error]} onRetry={ideas.reload} />
      )}
      {ideas.state.status === "ready" &&
        (ideas.state.data.length === 0 ? (
          <EmptyState icon={Inbox} title="Aucune idée dans ce challenge" action={importLink}>
            Importez l'export du formulaire de dépôt : le fichier sera analysé avant d'être enregistré.
          </EmptyState>
        ) : (
          <section className="space-y-3">
            <ChallengeContextCard challengeId={c.id} />
            {summaries.state.status === "ready" && (
              <BatchEvaluationBar
                ideaIds={ideas.state.data.map(i => i.id)}
                summaries={summaries.state.data}
                onProgress={summaries.reload}
              />
            )}
            <IdeaFilterBar
              ideas={ideas.state.data}
              filters={filters}
              onChange={setFilters}
              duplicatesAvailable={duplicates.state.status === "ready"}
            />
            <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
              {visible.length === ideas.state.data.length
                ? `${ideas.state.data.length} idée${ideas.state.data.length > 1 ? "s" : ""}`
                : `${visible.length} idée${visible.length > 1 ? "s" : ""} sur ${ideas.state.data.length}`}
            </p>
            {visible.length === 0 ? (
              <EmptyState
                icon={SearchX}
                title="Aucune idée ne correspond à ces filtres"
                action={
                  <Button variant="outline" onClick={() => setFilters(EMPTY_FILTERS)}>
                    Effacer les filtres
                  </Button>
                }
              >
                Modifiez ou retirez un filtre pour retrouver des idées.
              </EmptyState>
            ) : (
            <div className="overflow-x-auto rounded-lg border bg-background">
              <table className="w-full min-w-[1600px] text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="whitespace-nowrap px-4 py-2.5 font-medium">Identifiant</th>
                    <th className="px-2 py-2.5 font-medium">Titre</th>
                    <th className="px-2 py-2.5 font-medium">Description</th>
                    <th className="px-2 py-2.5 font-medium">Bénéfices attendus</th>
                    <th className="px-2 py-2.5 font-medium">Direction</th>
                    <th className="px-2 py-2.5 font-medium">Site</th>
                    <th className="px-2 py-2.5 font-medium">Thème</th>
                    <th className="px-2 py-2.5 text-right font-medium">Budget</th>
                    <th className="whitespace-nowrap px-2 py-2.5 font-medium">Date de dépôt</th>
                    <th className="whitespace-nowrap px-2 py-2.5 text-right font-medium">Note IA</th>
                    <th className="px-2 py-2.5 font-medium">Recommandation</th>
                    <th className="px-4 py-2.5 font-medium">Points d'attention</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {visible.map(i => {
                    const href = `/challenges/${c.id}/idees/${i.id}${params.size ? `?${params}` : ""}`;
                    return (
                      <tr
                        key={i.id}
                        onClick={e => {
                          // Toute la ligne ouvre la fiche, sauf si l'on sélectionne du texte.
                          if (!window.getSelection()?.toString() && !(e.target as HTMLElement).closest("a")) navigate(href);
                        }}
                        className="cursor-pointer hover:bg-muted/40"
                      >
                        <td className="whitespace-nowrap px-4 py-2.5 align-top font-mono text-xs text-muted-foreground">
                          {i.external_ref}
                        </td>
                        <td className="min-w-48 px-2 py-2.5 align-top">
                          <Link to={href} className="font-medium hover:underline">
                            {i.title}
                          </Link>
                        </td>
                        <td className="min-w-72 max-w-md px-2 py-2.5 align-top text-muted-foreground">
                          <p className="line-clamp-3" title={i.description}>
                            {i.description}
                          </p>
                        </td>
                        <td className="min-w-56 max-w-xs px-2 py-2.5 align-top text-muted-foreground">
                          {i.expected_benefits ? (
                            <p className="line-clamp-3" title={i.expected_benefits}>
                              {i.expected_benefits}
                            </p>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2.5 align-top">{i.direction ?? "—"}</td>
                        <td className="whitespace-nowrap px-2 py-2.5 align-top">{i.site ?? "—"}</td>
                        <td className="whitespace-nowrap px-2 py-2.5 align-top">{i.theme ?? "—"}</td>
                        <td
                          className="whitespace-nowrap px-2 py-2.5 text-right align-top tabular-nums"
                          title={i.budget_raw ?? undefined}
                        >
                          {i.budget_eur !== null ? (
                            euro.format(i.budget_eur)
                          ) : i.budget_raw ? (
                            <span className="text-muted-foreground">{i.budget_raw}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2.5 align-top tabular-nums">
                          {i.submitted_at ? dateFormat.format(new Date(`${i.submitted_at}T00:00:00`)) : "—"}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2.5 text-right align-top tabular-nums">
                          <AiScoreCell summary={summaryOf(i.id)} />
                        </td>
                        <td className="whitespace-nowrap px-2 py-2.5 align-top text-xs">
                          {summaryOf(i.id)?.recommendation ? recommendationLabels[summaryOf(i.id)!.recommendation!] : ""}
                        </td>
                        <td className="min-w-48 px-4 py-2.5 align-top text-xs text-amber-700">
                          {i.quality_flags.length > 0
                            ? i.quality_flags.map(f => rowWarningLabels[f as RowWarningCode] ?? f).join(", ")
                            : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            )}
          </section>
        ))}
    </div>
  );
}

function AiScoreCell({ summary }: { summary: EvaluationSummary | undefined }) {
  if (!summary) return <span className="text-muted-foreground">—</span>;
  if (summary.status === "running") return <span className="text-xs text-muted-foreground">en cours…</span>;
  if (summary.status === "failed") return <span className="text-xs text-destructive">échec</span>;
  return <span>{summary.aiScore === null ? "—" : summary.aiScore.toLocaleString("fr-FR", { minimumFractionDigits: 1 })}</span>;
}
