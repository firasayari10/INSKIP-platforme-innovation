import { ArrowLeft, ChevronLeft, ChevronRight, Copy, TriangleAlert, UserRound } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ErrorBlock, LoadingBlock } from "@/components/PageStates";
import { Button } from "@/components/ui/button";
import { filterIdeas, filtersFromParams } from "@/domain/ideaFilters";
import type { RowWarningCode } from "@/domain/importAnalysis";
import { useAuth } from "@/features/auth/AuthProvider";
import { useLoader } from "@/hooks/useLoader";
import { getChallenge, getIdea, listDuplicateIdeaIds, listDuplicatesOfIdea, listIdeas } from "@/lib/data";
import { dataErrorMessages, rowWarningLabels } from "@/lib/messages";
import { cn } from "@/lib/utils";

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const longDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });
const NO_DUPLICATES: ReadonlySet<string> = new Set();

const statusLabels = { suggested: "À examiner", confirmed: "Doublon confirmé", dismissed: "Écarté" } as const;

/** Fiche complète d'une idée : /challenges/:challengeId/idees/:ideaId (les filtres de la liste suivent dans l'adresse). */
export function IdeaPage() {
  const { challengeId = "", ideaId = "" } = useParams();
  const { client } = useAuth();
  const [params] = useSearchParams();
  const query = params.size ? `?${params}` : "";

  const challenge = useLoader(() => getChallenge(client, challengeId), [client, challengeId]);
  const idea = useLoader(() => getIdea(client, challengeId, ideaId), [client, challengeId, ideaId]);
  const related = useLoader(() => listDuplicatesOfIdea(client, challengeId, ideaId), [client, challengeId, ideaId]);
  // Pour « Précédente / Suivante » dans l'ordre de la liste filtrée.
  const all = useLoader(() => listIdeas(client, challengeId), [client, challengeId]);
  const dupIds = useLoader(() => listDuplicateIdeaIds(client, challengeId), [client, challengeId]);

  const neighbours = useMemo(() => {
    if (all.state.status !== "ready") return null;
    const list = filterIdeas(
      all.state.data,
      filtersFromParams(params),
      dupIds.state.status === "ready" ? dupIds.state.data : NO_DUPLICATES,
    );
    const index = list.findIndex(i => i.id === ideaId);
    if (index === -1) return null;
    return { index, total: list.length, prev: list[index - 1], next: list[index + 1] };
  }, [all.state, dupIds.state, params, ideaId]);

  const backHref = `/challenges/${challengeId}${query}`;
  const ideaHref = (id: string) => `/challenges/${challengeId}/idees/${id}${query}`;

  if (idea.state.status === "loading") return <LoadingBlock label="Chargement de l'idée…" />;
  if (idea.state.status === "error")
    return (
      <div className="space-y-4">
        <BackLink href={backHref} />
        <ErrorBlock message={dataErrorMessages[idea.state.error]} onRetry={idea.reload} />
      </div>
    );
  const i = idea.state.data;
  const authorName = [i.author?.first_name, i.author?.last_name].filter(Boolean).join(" ");

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <BackLink href={backHref} label={challenge.state.status === "ready" ? challenge.state.data.title : undefined} />
          {neighbours && (
            <nav className="flex items-center gap-2 text-sm text-muted-foreground" aria-label="Parcourir les idées">
              <span className="tabular-nums">
                Idée {neighbours.index + 1} sur {neighbours.total}
              </span>
              <NavButton to={neighbours.prev && ideaHref(neighbours.prev.id)} label="Idée précédente">
                <ChevronLeft className="size-4" aria-hidden />
                Précédente
              </NavButton>
              <NavButton to={neighbours.next && ideaHref(neighbours.next.id)} label="Idée suivante">
                Suivante
                <ChevronRight className="size-4" aria-hidden />
              </NavButton>
            </nav>
          )}
        </div>
        <div className="space-y-1">
          <p className="font-mono text-xs text-muted-foreground">{i.external_ref}</p>
          <h1 className="text-2xl font-semibold tracking-tight">{i.title}</h1>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Block title="Description">
            <p className="whitespace-pre-line leading-relaxed">{i.description}</p>
          </Block>
          <Block title="Bénéfices attendus">
            {i.expected_benefits ? (
              <p className="whitespace-pre-line leading-relaxed">{i.expected_benefits}</p>
            ) : (
              <p className="text-muted-foreground">Non renseignés.</p>
            )}
          </Block>

          {i.quality_flags.length > 0 && (
            <Block title="Points d'attention relevés à l'import" icon={<TriangleAlert className="size-4 text-amber-600" aria-hidden />}>
              <ul className="list-disc space-y-1 pl-5">
                {i.quality_flags.map(f => (
                  <li key={f}>{rowWarningLabels[f as RowWarningCode] ?? f}</li>
                ))}
              </ul>
            </Block>
          )}

          <Block title="Doublons possibles" icon={<Copy className="size-4 text-muted-foreground" aria-hidden />}>
            {related.state.status === "loading" && <p className="text-muted-foreground">Chargement…</p>}
            {related.state.status === "error" && (
              <p className="text-destructive">{dataErrorMessages[related.state.error]}</p>
            )}
            {related.state.status === "ready" &&
              (related.state.data.length === 0 ? (
                <p className="text-muted-foreground">Aucune idée proche n'a été détectée.</p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {related.state.data.map(d => (
                    <li key={d.pairId} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2.5">
                      <Link to={ideaHref(d.other.id)} className="min-w-0 hover:underline">
                        <span className="mr-2 font-mono text-xs text-muted-foreground">{d.other.external_ref}</span>
                        <span className="font-medium">{d.other.title}</span>
                      </Link>
                      <span className="text-xs text-muted-foreground">
                        {d.kind === "exact" ? "Contenu identique" : `Formulation proche · ${Math.round(d.similarity * 100)} %`}
                        {" · "}
                        {statusLabels[d.status]}
                      </span>
                    </li>
                  ))}
                </ul>
              ))}
          </Block>
        </div>

        <aside className="space-y-6">
          <Block title="Informations">
            <dl className="divide-y">
              <Field label="Direction" value={i.direction} />
              <Field label="Site" value={i.site} />
              <Field label="Thème" value={i.theme} />
              <Field
                label="Budget estimé"
                value={i.budget_eur !== null ? euro.format(i.budget_eur) : null}
                hint={i.budget_raw && (i.budget_eur === null || i.quality_flags.includes("budget_avec_commentaire")) ? `Saisi : « ${i.budget_raw} »` : undefined}
              />
              <Field
                label="Date de dépôt"
                value={i.submitted_at ? longDate.format(new Date(`${i.submitted_at}T00:00:00`)) : null}
                hint={i.submitted_at_raw && i.submitted_at_raw !== i.submitted_at ? `Saisi : « ${i.submitted_at_raw} »` : undefined}
              />
            </dl>
          </Block>

          <Block title="Auteur" icon={<UserRound className="size-4 text-muted-foreground" aria-hidden />}>
            <p>{authorName || <span className="text-muted-foreground">Non renseigné</span>}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Donnée personnelle : visible ici uniquement, jamais transmise à l'IA ni incluse dans les exports par défaut.
            </p>
          </Block>
        </aside>
      </div>
    </div>
  );
}

function BackLink({ href, label }: { href: string; label?: string }) {
  return (
    <Link to={href} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" aria-hidden />
      {label ? `Retour à « ${label} »` : "Retour à la liste"}
    </Link>
  );
}

function NavButton({ to, label, children }: { to: string | undefined; label: string; children: ReactNode }) {
  if (!to)
    return (
      <Button variant="outline" size="sm" disabled aria-label={label}>
        {children}
      </Button>
    );
  return (
    <Button variant="outline" size="sm" asChild>
      <Link to={to} aria-label={label}>
        {children}
      </Link>
    </Button>
  );
}

function Block({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border bg-background p-5 text-sm">
      <h2 className="mb-3 flex items-center gap-2 font-medium">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 py-2 first:pt-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn(!value && "text-muted-foreground")}>
        {value ?? "Non renseigné"}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </dd>
    </div>
  );
}
