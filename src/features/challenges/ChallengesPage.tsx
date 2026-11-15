import { ChevronRight, FolderOpen, LoaderCircle, Plus } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Alert } from "@/components/Alert";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/PageStates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/features/auth/AuthProvider";
import { useLoader } from "@/hooks/useLoader";
import { createChallenge, listChallenges, newChallengeSchema } from "@/lib/data";
import { dataErrorMessages } from "@/lib/messages";

const dateFormat = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });

export function ChallengesPage() {
  const { client } = useAuth();
  const { state, reload } = useLoader(() => listChallenges(client), [client]);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Vos challenges</h1>
          <p className="text-sm text-muted-foreground">Retrouvez ici les challenges d'innovation que vous évaluez.</p>
        </div>
        {state.status === "ready" && state.data.length > 0 && !creating && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden />
            Nouveau challenge
          </Button>
        )}
      </header>

      {creating && <NewChallengeForm onCancel={() => setCreating(false)} />}

      {state.status === "loading" && <LoadingBlock label="Chargement des challenges…" />}
      {state.status === "error" && <ErrorBlock message={dataErrorMessages[state.error]} onRetry={reload} />}
      {state.status === "ready" &&
        (state.data.length === 0 ? (
          !creating && (
            <EmptyState
              icon={FolderOpen}
              title="Aucun challenge pour le moment"
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus className="size-4" aria-hidden />
                  Créer un premier challenge
                </Button>
              }
            >
              Créez un challenge pour y importer les idées des équipes et commencer l'évaluation.
            </EmptyState>
          )
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {state.data.map(c => (
              <li key={c.id}>
                <Link
                  to={`/challenges/${c.id}`}
                  className="group flex h-full items-center justify-between gap-4 rounded-xl border bg-background p-5 transition-colors hover:border-foreground/20 hover:bg-muted/40 focus-visible:outline-2"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{c.client_name}</p>
                    <p className="truncate font-medium">{c.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {c.ideaCount === 0 ? "Aucune idée importée" : `${c.ideaCount} idée${c.ideaCount > 1 ? "s" : ""}`}
                      {" · "}créé le {dateFormat.format(new Date(c.created_at))}
                    </p>
                  </div>
                  <ChevronRight
                    className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                    aria-hidden
                  />
                </Link>
              </li>
            ))}
          </ul>
        ))}
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

  const field = (name: keyof typeof values, label: string, placeholder: string) => (
    <div className="space-y-2">
      <Label htmlFor={`${id}-${name}`}>{label}</Label>
      <Input
        id={`${id}-${name}`}
        value={values[name]}
        placeholder={placeholder}
        onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))}
        aria-invalid={fieldErrors[name] ? true : undefined}
        aria-describedby={fieldErrors[name] ? `${id}-${name}-error` : undefined}
        disabled={pending}
        className="h-10"
      />
      {fieldErrors[name] && (
        <p id={`${id}-${name}-error`} className="text-sm text-destructive">
          {fieldErrors[name]}
        </p>
      )}
    </div>
  );

  return (
    <form onSubmit={submit} noValidate className="space-y-5 rounded-xl border bg-background p-6">
      <div className="space-y-1">
        <h2 className="font-medium">Nouveau challenge</h2>
        <p className="text-sm text-muted-foreground">Vous pourrez ensuite importer le fichier des idées.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {field("title", "Nom du challenge", "Challenge innovation 2026")}
        {field("client_name", "Client", "Hexavia")}
      </div>
      {formError && <Alert tone="error">{formError}</Alert>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>
          {pending && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
          Créer et importer les idées
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Annuler
        </Button>
      </div>
    </form>
  );
}
