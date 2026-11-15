import { FileUp } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { DataGrid, emptyGridQuery } from "@/components/data-grid/DataGrid";
import { PageHeader } from "@/components/PageHeader";
import { ErrorBlock, LoadingBlock } from "@/components/PageStates";
import { Button } from "@/components/ui/button";
import { sumKnown } from "@/domain/grid";
import { useAuth } from "@/features/auth/AuthProvider";
import { useLoader } from "@/hooks/useLoader";
import { getChallenge, listIdeas } from "@/lib/data";
import { formatDate, formatEuro, plural } from "@/lib/format";
import { dataErrorMessages } from "@/lib/messages";
import { fromIdeaRow, ideaColumns, ideaDefaultSort, type IdeaGridRow } from "./ideaColumns";

export function ChallengePage() {
  const { challengeId = "" } = useParams();
  const { client } = useAuth();
  const challenge = useLoader(() => getChallenge(client, challengeId), [client, challengeId]);
  const ideas = useLoader(() => listIdeas(client, challengeId), [client, challengeId]);
  const [query, setQuery] = useState(emptyGridQuery);
  const rows = useMemo(() => (ideas.state.status === "ready" ? ideas.state.data.map(fromIdeaRow) : []), [ideas.state]);

  if (challenge.state.status === "loading") return <LoadingBlock label="Chargement du challenge…" />;
  if (challenge.state.status === "error")
    return <ErrorBlock message={dataErrorMessages[challenge.state.error]} onRetry={challenge.reload} />;
  const c = challenge.state.data;
  const importPath = `/challenges/${c.id}/import`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        breadcrumb={[{ label: "Challenges", to: "/" }, { label: c.title }]}
        title={c.title}
        meta={
          <>
            Client : {c.client_name}
            {c.jury_date && ` · Jury le ${formatDate(c.jury_date)}`}
          </>
        }
      />

      {ideas.state.status === "error" ? (
        <ErrorBlock message={dataErrorMessages[ideas.state.error]} onRetry={ideas.reload} />
      ) : (
        <DataGrid<IdeaGridRow>
          className="mx-4 mb-3"
          label="Idées du challenge"
          rows={rows}
          columns={ideaColumns}
          rowKey={r => r.ref}
          rowLabel={r => r.ref}
          query={query}
          onQueryChange={setQuery}
          defaultSort={ideaDefaultSort}
          loadingLabel={ideas.state.status === "loading" ? "Chargement des idées…" : undefined}
          searchLabel="Rechercher dans les idées"
          countLabel={n => plural(n, "idée", "idées")}
          shownLabel={n => plural(n, "affichée", "affichées")}
          noMatchLabel="Aucune idée ne correspond à la recherche ou aux filtres."
          actions={
            <Button size="sm" asChild>
              <Link to={importPath}>
                <FileUp className="size-3.5" aria-hidden />
                Importer un fichier
              </Link>
            </Button>
          }
          emptyBody={
            <>
              <p>
                Aucune idée dans ce challenge. Importez l'export du formulaire de dépôt (fichier CSV) : il sera vérifié
                avant tout enregistrement.
              </p>
              <Button size="sm" className="mt-2" asChild>
                <Link to={importPath}>Importer un fichier</Link>
              </Button>
            </>
          }
          statusRight={shown => {
            const { sum, missing } = sumKnown(shown.map(r => r.budgetEur));
            return `Somme des budgets affichés : ${formatEuro(sum)}${missing > 0 ? ` (${plural(missing, "non chiffré", "non chiffrés")})` : ""}`;
          }}
        />
      )}
    </div>
  );
}
