import { LoaderCircle, Pencil } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { DEFAULT_CLIENT_CONTEXT } from "@/domain/scoring";
import { useAuth } from "@/features/auth/AuthProvider";
import { useLoader } from "@/hooks/useLoader";
import { dataErrorMessages } from "@/lib/messages";
import { CONTEXT_MAX, getChallengeContext, saveChallengeContext } from "@/lib/scoringData";

const PLACEHOLDER = `Exemple :
Groupe industriel français, environ 4 000 salariés, 8 sites de production.
Stratégie RSE : réduire les émissions de CO2 de 30 % d'ici 2030, zéro accident grave.
Stratégie financière : améliorer la marge opérationnelle de 2 points, investissements limités et ROI < 3 ans.
Priorités : excellence opérationnelle, maintenance prédictive, digitalisation des ateliers, attractivité RH.`;

/** Contexte et stratégie du client : indispensable à l'agent « Alignement stratégique ». */
export function ChallengeContextCard({ challengeId }: { challengeId: string }) {
  const id = useId();
  const { client } = useAuth();
  const context = useLoader(() => getChallengeContext(client, challengeId), [client, challengeId]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = context.state.status === "ready" ? context.state.data : null;
  useEffect(() => setDraft(current ?? DEFAULT_CLIENT_CONTEXT), [current]);

  const save = async () => {
    setPending(true);
    setError(null);
    const r = await saveChallengeContext(client, challengeId, draft);
    setPending(false);
    if (!r.ok) return setError(dataErrorMessages[r.error]);
    setEditing(false);
    context.reload();
  };

  if (context.state.status === "error") return <Alert tone="error">{dataErrorMessages[context.state.error]}</Alert>;

  return (
    <section className="space-y-3 rounded-lg border bg-background p-4 text-sm" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={`${id}-title`} className="font-semibold">
            Contexte et stratégie du client
          </h2>
          <p className="text-muted-foreground">
            Utilisé par les agents pour juger l'alignement stratégique des idées (RSE, finance, priorités industrielles).
          </p>
        </div>
        {!editing && context.state.status === "ready" && (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="size-4" aria-hidden />
            {current ? "Modifier" : "Personnaliser"}
          </Button>
        )}
      </div>

      {context.state.status === "loading" && <p className="text-muted-foreground">Chargement…</p>}

      {!editing && context.state.status === "ready" &&
        (current ? (
          <p className="whitespace-pre-line leading-relaxed">{current}</p>
        ) : (
          <div className="space-y-2">
            <p className="inline-block rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
              Hypothèse de travail utilisée par défaut
            </p>
            <p className="whitespace-pre-line leading-relaxed text-muted-foreground">{DEFAULT_CLIENT_CONTEXT}</p>
            <p className="text-xs text-muted-foreground">
              Contexte supposé, non confirmé par le client : les agents le signalent quand leur conclusion en dépend.
              Personnalisez-le dès que le client a partagé sa stratégie.
            </p>
          </div>
        ))}

      {editing && (
        <div className="space-y-2">
          <textarea
            id={`${id}-text`}
            value={draft}
            onChange={e => setDraft(e.target.value.slice(0, CONTEXT_MAX))}
            rows={8}
            placeholder={PLACEHOLDER}
            aria-label="Contexte et stratégie du client"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm leading-relaxed"
          />
          <p className="text-xs text-muted-foreground">
            {draft.length} / {CONTEXT_MAX} caractères. N'indiquez aucune donnée personnelle.
          </p>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={pending}>
              {pending && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
              Enregistrer
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(current ?? DEFAULT_CLIENT_CONTEXT);
                setEditing(false);
              }}
              disabled={pending}
            >
              Annuler
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
