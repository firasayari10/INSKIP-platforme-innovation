import { ArrowLeft, FileDown, RotateCcw, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { Alert } from "@/components/Alert";
import { ErrorBlock, LoadingBlock } from "@/components/PageStates";
import { Button } from "@/components/ui/button";
import { effectiveContext } from "@/domain/scoring";
import { rankIdeas, type RankedIdea } from "@/domain/shortlist";
import { useAuth } from "@/features/auth/AuthProvider";
import { useLoader } from "@/hooks/useLoader";
import { dataErrorMessages, estimableFieldLabels, recommendationLabels } from "@/lib/messages";
import { getChallengeReport, type ChallengeReport, type ReportIdea } from "@/lib/reportData";
import { cn } from "@/lib/utils";

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const longDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });
const fmtScore = (n: number | null) => (n === null ? "—" : n.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));

/**
 * Rapport final pour le jury : les meilleures idées, leur note et l'explication de la décision.
 * Anonyme (aucun auteur). Imprimable / enregistrable en PDF depuis le navigateur.
 */
export function ReportPage() {
  const { challengeId = "" } = useParams();
  const { client } = useAuth();
  const report = useLoader(() => getChallengeReport(client, challengeId), [client, challengeId]);

  if (report.state.status === "loading") return <LoadingBlock label="Préparation du rapport…" />;
  if (report.state.status === "error") return <ErrorBlock message={dataErrorMessages[report.state.error]} onRetry={report.reload} />;
  return <Report data={report.state.data} />;
}

function Report({ data }: { data: ChallengeReport }) {
  const [size, setSize] = useState(Math.min(20, Math.max(1, data.challenge.shortlist_size)));
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const byId = useMemo(() => new Map(data.ideas.map(i => [i.idea.id, i])), [data.ideas]);

  const ranking = useMemo(
    () =>
      rankIdeas(
        data.ideas
          .filter(i => !excluded.has(i.idea.id))
          .map(i => ({
            ideaId: i.idea.id,
            ref: i.idea.external_ref,
            aiScore: i.aiScore,
            validatedScore: i.validatedScore,
            recommendation: i.recommendation,
          })),
        data.confirmedDuplicates,
        size,
      ),
    [data, excluded, size],
  );

  const evaluatedCount = data.ideas.filter(i => i.aiScore !== null || i.validatedScore !== null).length;
  const validatedCount = ranking.selected.filter(r => r.scoreSource === "validee").length;
  const context = effectiveContext(data.challenge.context);
  const toggle = (id: string) =>
    setExcluded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-8">
      {/* Barre d'outils : écran seulement */}
      <div className="space-y-4 print:hidden">
        <Link to={`/challenges/${data.challenge.id}`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          {data.challenge.title}
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4 rounded-lg border bg-background p-4">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">Rapport pour le jury</h1>
            <p className="text-sm text-muted-foreground">
              {evaluatedCount} idée{evaluatedCount > 1 ? "s" : ""} évaluée{evaluatedCount > 1 ? "s" : ""} sur {data.ideas.length}. Retirez
              une idée pour faire monter la suivante ; le rapport est anonyme.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              Nombre d'idées
              <input
                type="number"
                min={1}
                max={20}
                value={size}
                onChange={e => setSize(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
                className="h-9 w-16 rounded-md border bg-background px-2 text-sm"
              />
            </label>
            {excluded.size > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setExcluded(new Set())}>
                <RotateCcw className="size-4" aria-hidden />
                Rétablir ({excluded.size})
              </Button>
            )}
            <Button onClick={() => window.print()} disabled={ranking.selected.length === 0}>
              <FileDown className="size-4" aria-hidden />
              Imprimer / enregistrer en PDF
            </Button>
          </div>
        </div>
        {ranking.selected.length === 0 && (
          <Alert tone="info">
            Aucune idée évaluée pour l'instant : lancez l'évaluation des idées depuis la page du challenge, puis revenez ici.
          </Alert>
        )}
        {validatedCount < ranking.selected.length && ranking.selected.length > 0 && (
          <Alert tone="info">
            {ranking.selected.length - validatedCount} idée{ranking.selected.length - validatedCount > 1 ? "s" : ""} de la sélection
            n'{ranking.selected.length - validatedCount > 1 ? "ont" : "a"} pas encore de note validée : le rapport indique alors la note
            proposée par l'IA, signalée comme telle. Validez les notes sur la fiche de chaque idée avant l'envoi au client.
          </Alert>
        )}
      </div>

      {ranking.selected.length > 0 && (
        <article className="report mx-auto max-w-4xl space-y-10 bg-background text-[15px] leading-relaxed print:max-w-none print:space-y-6">
          {/* Page de garde */}
          <header className="space-y-6 border-b pb-8">
            <p className="text-sm uppercase tracking-widest text-muted-foreground">Challenge d'innovation · {data.challenge.client_name}</p>
            <h1 className="text-3xl font-semibold leading-tight">{data.challenge.title}</h1>
            <p className="text-xl">Sélection de {ranking.selected.length} idées proposée au jury</p>
            <dl className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-3">
              <Meta label="Idées déposées" value={String(data.ideas.length)} />
              <Meta label="Idées évaluées" value={String(evaluatedCount)} />
              <Meta label="Date du rapport" value={longDate.format(new Date())} />
              {data.challenge.jury_date && <Meta label="Jury" value={longDate.format(new Date(`${data.challenge.jury_date}T00:00:00`))} />}
            </dl>
          </header>

          <Section title="Synthèse">
            <table className="w-full text-left text-sm">
              <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3">Rang</th>
                  <th className="py-2 pr-3">Idée</th>
                  <th className="py-2 pr-3">Thème</th>
                  <th className="py-2 pr-3 text-right">Note / 5</th>
                  <th className="py-2">Recommandation</th>
                  <th className="py-2 print:hidden" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {ranking.selected.map(r => (
                  <tr key={r.ideaId}>
                    <td className="py-2 pr-3 font-semibold tabular-nums">{r.rank}</td>
                    <td className="py-2 pr-3">
                      <span className="font-medium">{byId.get(r.ideaId)!.idea.title}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{r.ref}</span>
                    </td>
                    <td className="py-2 pr-3">{byId.get(r.ideaId)!.idea.theme ?? "—"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {fmtScore(r.score)}
                      {r.scoreSource === "ia" && <sup className="ml-0.5 text-muted-foreground">*</sup>}
                    </td>
                    <td className="py-2">{r.recommendation ? recommendationLabels[r.recommendation] : "—"}</td>
                    <td className="py-2 text-right print:hidden">
                      <Button variant="ghost" size="sm" onClick={() => toggle(r.ideaId)} aria-label={`Retirer ${r.ref} du rapport`}>
                        <X className="size-4" aria-hidden />
                        Retirer
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ranking.selected.some(r => r.scoreSource === "ia") && (
              <p className="mt-2 text-xs text-muted-foreground">* Note proposée par l'analyse, non encore validée par le consultant.</p>
            )}
          </Section>

          <Section title="Méthodologie">
            <p>
              Chaque idée a été analysée sur {data.criteria.length} critères notés de 1 à 5, par une équipe d'analyse assistée par
              l'intelligence artificielle (un analyste, un consultant par critère et un associé chargé de la synthèse), puis revue et
              validée par le consultant. La note globale est la moyenne pondérée des notes par critère. Les données manquantes ont été
              estimées et signalées comme telles ; aucune donnée personnelle n'a été transmise aux outils d'analyse.
            </p>
            <ul className="mt-3 space-y-1">
              {data.criteria.map(c => (
                <li key={c.id}>
                  <span className="font-medium">{c.label}</span>
                  {c.weight !== 1 && <span className="text-muted-foreground"> (poids {c.weight})</span>} — {c.description}
                </li>
              ))}
            </ul>
            {context.assumed && (
              <p className="mt-3 text-sm text-muted-foreground">
                L'alignement stratégique a été apprécié au regard d'un contexte de travail supposé (stratégie RSE, financière et
                industrielle d'un groupe industriel), à confirmer avec le client.
              </p>
            )}
          </Section>

          {ranking.selected.map(r => (
            <IdeaSheet key={r.ideaId} ranked={r} data={byId.get(r.ideaId)!} onRemove={() => toggle(r.ideaId)} />
          ))}

          {(ranking.others.length > 0 || ranking.duplicates.length > 0) && (
            <Section title="Annexe — autres idées évaluées" breakBefore>
              <table className="w-full text-left text-sm">
                <tbody className="divide-y">
                  {ranking.others.map(r => (
                    <tr key={r.ideaId}>
                      <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{r.rank}</td>
                      <td className="py-1.5 pr-3">
                        {byId.get(r.ideaId)!.idea.title} <span className="text-xs text-muted-foreground">{r.ref}</span>
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {fmtScore(r.score)}
                        {r.scoreSource === "ia" && <sup className="ml-0.5 text-muted-foreground">*</sup>}
                      </td>
                      <td className="py-1.5">{r.recommendation ? recommendationLabels[r.recommendation] : "—"}</td>
                    </tr>
                  ))}
                  {ranking.duplicates.map(d => (
                    <tr key={d.ideaId} className="text-muted-foreground">
                      <td className="py-1.5 pr-3">—</td>
                      <td className="py-1.5 pr-3" colSpan={3}>
                        {byId.get(d.ideaId)!.idea.title} <span className="text-xs">{d.ref}</span> : doublon de {d.duplicateOfRef}, regroupée
                        avec elle
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {excluded.size > 0 && (
            <div className="rounded-md border border-dashed p-4 text-sm print:hidden">
              <p className="font-medium">Idées retirées du rapport</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {[...excluded].map(id => (
                  <li key={id}>
                    <Button variant="outline" size="sm" onClick={() => toggle(id)}>
                      Réintégrer {byId.get(id)?.idea.external_ref}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </article>
      )}
    </div>
  );
}

function IdeaSheet({ ranked, data, onRemove }: { ranked: RankedIdea; data: ReportIdea; onRemove: () => void }) {
  const s = data.synthesis;
  const facts = [data.idea.direction, data.idea.site, data.idea.theme].filter(Boolean).join(" · ");
  return (
    <section className="space-y-4 border-t pt-8 print:break-before-page print:border-t-0 print:pt-0">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            N° {ranked.rank} · {data.idea.external_ref}
            {facts && ` · ${facts}`}
          </p>
          <h2 className="text-2xl font-semibold leading-snug">{data.idea.title}</h2>
        </div>
        <div className="text-right">
          <p className="text-3xl font-semibold tabular-nums">
            {fmtScore(ranked.score)}
            <span className="text-base font-normal text-muted-foreground"> / 5</span>
          </p>
          <p className="text-xs text-muted-foreground">{ranked.scoreSource === "validee" ? "Note validée" : "Note proposée, à valider"}</p>
          {ranked.recommendation && <p className="mt-1 text-sm font-medium">{recommendationLabels[ranked.recommendation]}</p>}
        </div>
      </div>

      <p>{data.idea.description}</p>
      {(data.idea.expected_benefits || data.idea.budget_raw) && (
        <p className="text-sm text-muted-foreground">
          {data.idea.expected_benefits && <>Bénéfices attendus : {data.idea.expected_benefits}. </>}
          {data.idea.budget_eur !== null ? <>Budget estimé par le porteur : {euro.format(data.idea.budget_eur)}.</> : data.idea.budget_raw ? <>Budget : {data.idea.budget_raw}.</> : null}
        </p>
      )}

      <table className="w-full text-left text-sm">
        <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="py-1.5 pr-3">Critère</th>
            <th className="py-1.5 pr-3 text-right">Note</th>
            <th className="py-1.5">Appréciation</th>
          </tr>
        </thead>
        <tbody className="divide-y align-top">
          {data.criteria.map(c => (
            <tr key={c.criterion.id}>
              <td className="py-2 pr-3 font-medium">{c.criterion.label}</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {c.score ?? "—"}/5{!c.validated && c.score !== null && <sup className="ml-0.5 text-muted-foreground">*</sup>}
              </td>
              <td className="py-2">
                {c.summary ?? "—"}
                {c.comment && <span className="mt-1 block text-muted-foreground">Avis du consultant : {c.comment}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {s?.synthese && (
        <div>
          <h3 className="font-semibold">Pourquoi cette idée</h3>
          <p className="mt-1">{s.synthese}</p>
          {s.justification_recommandation && <p className="mt-2">{s.justification_recommandation}</p>}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 print:grid-cols-2">
        <Bullets title="Points forts" items={s?.points_forts} />
        <Bullets title="Points de vigilance" items={[...(s?.points_faibles ?? []), ...(s?.incoherences ?? [])]} />
      </div>
      <Bullets title="Prochaines étapes recommandées" items={s?.prochaines_etapes} />
      {data.estimates.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Données estimées par l'analyse (absentes du dossier) :{" "}
          {data.estimates.map(e => `${estimableFieldLabels[e.field] ?? e.field} ≈ ${e.value}`).join(" ; ")}.
        </p>
      )}
      <Button variant="ghost" size="sm" onClick={onRemove} className="print:hidden">
        <X className="size-4" aria-hidden />
        Retirer cette idée du rapport
      </Button>
    </section>
  );
}

function Section({ title, children, breakBefore = false }: { title: string; children: ReactNode; breakBefore?: boolean }) {
  return (
    <section className={cn("space-y-3", breakBefore && "print:break-before-page")}>
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function Bullets({ title, items }: { title: string; items: string[] | undefined }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <h3 className="font-semibold">{title}</h3>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {items.map(i => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}
