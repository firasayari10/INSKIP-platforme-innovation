import { ArrowLeft, FileUp, Inbox } from "lucide-react";
import { Link, useParams } from "react-router";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/PageStates";
import { Button } from "@/components/ui/button";
import type { RowWarningCode } from "@/domain/importAnalysis";
import { useAuth } from "@/features/auth/AuthProvider";
import { useLoader } from "@/hooks/useLoader";
import { getChallenge, listIdeas } from "@/lib/data";
import { dataErrorMessages, rowWarningLabels } from "@/lib/messages";

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

export function ChallengePage() {
  const { challengeId = "" } = useParams();
  const { client } = useAuth();
  const challenge = useLoader(() => getChallenge(client, challengeId), [client, challengeId]);
  const ideas = useLoader(() => listIdeas(client, challengeId), [client, challengeId]);

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
          {ideas.state.status === "ready" && ideas.state.data.length > 0 && importLink}
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
            <p className="text-sm text-muted-foreground">
              {ideas.state.data.length} idée{ideas.state.data.length > 1 ? "s" : ""}
            </p>
            <div className="overflow-x-auto rounded-lg border bg-background">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Idée</th>
                    <th className="px-2 py-2.5 font-medium">Direction · site</th>
                    <th className="px-2 py-2.5 font-medium">Thème</th>
                    <th className="px-4 py-2.5 text-right font-medium">Budget</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {ideas.state.data.map(i => (
                    <tr key={i.id}>
                      <td className="px-4 py-2.5 align-top">
                        <p className="font-medium">{i.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {i.external_ref}
                          {i.quality_flags.length > 0 && (
                            <span className="text-amber-700">
                              {" "}
                              · {i.quality_flags.map(f => rowWarningLabels[f as RowWarningCode] ?? f).join(", ")}
                            </span>
                          )}
                        </p>
                      </td>
                      <td className="px-2 py-2.5 align-top">{[i.direction, i.site].filter(Boolean).join(" · ") || "—"}</td>
                      <td className="px-2 py-2.5 align-top">{i.theme ?? "—"}</td>
                      <td className="px-4 py-2.5 text-right align-top tabular-nums" title={i.budget_raw ?? undefined}>
                        {i.budget_eur !== null ? euro.format(i.budget_eur) : <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
    </div>
  );
}
