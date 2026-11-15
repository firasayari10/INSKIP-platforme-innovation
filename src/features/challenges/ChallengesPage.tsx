import { LoaderCircle, Plus } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Alert } from "@/components/Alert";
import { DataGrid, emptyGridQuery } from "@/components/data-grid/DataGrid";
import type { DataGridColumn } from "@/components/data-grid/types";
import { PageHeader } from "@/components/PageHeader";
import { ErrorBlock } from "@/components/PageStates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { GridSort } from "@/domain/grid";
import { useAuth } from "@/features/auth/AuthProvider";
import { useLoader } from "@/hooks/useLoader";
import { createChallenge, listChallenges, newChallengeSchema, type Challenge } from "@/lib/data";
import { plural } from "@/lib/format";
import { dataErrorMessages } from "@/lib/messages";

const defaultSort: GridSort = { key: "created_at", direction: "desc" };

const columns: DataGridColumn<Challenge>[] = [
  {
    key: "title",
    label: "Challenge",
    width: 320,
    kind: "text",
    frozen: true,
    value: c => c.title,
    render: c => (
      <Link to={`/challenges/${c.id}`} tabIndex={-1} className="text-primary hover:underline">
        {c.title}
      </Link>
    ),
  },
  { key: "client_name", label: "Client", width: 200, kind: "text", filter: "values", value: c => c.client_name },
  { key: "ideaCount", label: "Idées", width: 80, kind: "number", value: c => c.ideaCount },
  { key: "jury_date", label: "Date du jury", width: 112, kind: "date", value: c => c.jury_date },
  { key: "created_at", label: "Créé le", width: 112, kind: "date", value: c => c.created_at },
];

export function ChallengesPage() {
  const { client } = useAuth();
  const navigate = useNavigate();
  const { state, reload } = useLoader(() => listChallenges(client), [client]);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState(emptyGridQuery);

  const newButton = (size: "default" | "sm") => (
    <Button size={size} onClick={() => setCreating(true)} disabled={creating}>
      <Plus className="size-3.5" aria-hidden />
      Nouveau challenge
    </Button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Challenges" />

      {creating && <NewChallengeForm onCancel={() => setCreating(false)} />}

      {state.status === "error" ? (
        <ErrorBlock message={dataErrorMessages[state.error]} onRetry={reload} />
      ) : (
        <DataGrid<Challenge>
          className="mx-4 mb-3"
          label="Challenges"
          rows={state.status === "ready" ? state.data : []}
          columns={columns}
          rowKey={c => c.id}
          rowLabel={c => c.client_name}
          query={query}
          onQueryChange={setQuery}
          defaultSort={defaultSort}
          loadingLabel={state.status === "loading" ? "Chargement des challenges…" : undefined}
          searchLabel="Rechercher un challenge"
          countLabel={n => plural(n, "challenge", "challenges")}
          shownLabel={n => plural(n, "affiché", "affichés")}
          noMatchLabel="Aucun challenge ne correspond à la recherche ou aux filtres."
          onOpenRow={c => navigate(`/challenges/${c.id}`)}
          actions={newButton("sm")}
          emptyBody={
            <>
              <p>Aucun challenge pour le moment. Créez-en un pour importer les idées des équipes.</p>
              <div className="mt-2">{newButton("sm")}</div>
            </>
          }
        />
      )}
    </div>
  );
}

function NewChallengeForm({ onCancel }: { onCancel: () => void }) {
  const id = useId();
  const { client } = useAuth();
  const navigate = useNavigate();
  const [values, setValues] = useState({ title: "", client_name: "" });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof typeof values, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setFormError(null);
    const parsed = newChallengeSchema.safeParse(values);
    if (!parsed.success) {
      const errors: typeof fieldErrors = {};
      for (const issue of parsed.error.issues) errors[issue.path[0] as keyof typeof values] ??= issue.message;
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setPending(true);
    const result = await createChallenge(client, parsed.data);
    setPending(false);
    if (!result.ok) {
      setFormError(dataErrorMessages[result.error]);
      return;
    }
    navigate(`/challenges/${result.value.id}/import`);
  };

  const field = (name: keyof typeof values, label: string, placeholder: string, autoFocus = false) => (
    <div className="space-y-1">
      <Label htmlFor={`${id}-${name}`}>{label}</Label>
      <Input
        id={`${id}-${name}`}
        value={values[name]}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))}
        aria-invalid={fieldErrors[name] ? true : undefined}
        aria-describedby={fieldErrors[name] ? `${id}-${name}-error` : undefined}
        disabled={pending}
      />
      {fieldErrors[name] && (
        <p id={`${id}-${name}-error`} className="text-xs text-destructive">
          {fieldErrors[name]}
        </p>
      )}
    </div>
  );

  return (
    <form
      onSubmit={submit}
      onKeyDown={e => {
        if (e.key === "Escape" && !pending) {
          e.preventDefault();
          onCancel();
        }
      }}
      noValidate
      aria-labelledby={`${id}-title`}
      className="mx-4 mb-3 max-w-2xl shrink-0 space-y-3 rounded-sm border border-border bg-background p-4"
    >
      <div>
        <h2 id={`${id}-title`} className="text-sm font-semibold">
          Nouveau challenge
        </h2>
        <p className="text-xs text-muted-foreground">Vous importerez ensuite le fichier des idées.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {field("title", "Nom du challenge", "Ex. : Challenge innovation 2026", true)}
        {field("client_name", "Client", "Ex. : Hexavia")}
      </div>
      {formError && <Alert tone="error">{formError}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
          {pending ? "Création…" : "Créer et importer les idées"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Annuler
        </Button>
      </div>
    </form>
  );
}
