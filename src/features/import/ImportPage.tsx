import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  Copy,
  FileSpreadsheet,
  FileUp,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { Alert } from "@/components/Alert";
import { ErrorBlock, LoadingBlock } from "@/components/PageStates";
import { Button } from "@/components/ui/button";
import {
  analyzeImport,
  buildImportPayload,
  type AnalyzedIdea,
  type ImportAnalysis,
  type RowWarningCode,
} from "@/domain/importAnalysis";
import { contentKey } from "@/domain/text";
import { useAuth } from "@/features/auth/AuthProvider";
import { useLoader } from "@/hooks/useLoader";
import { checkFile, parseCsvText } from "@/lib/csv";
import { getChallenge, importIdeas, type ImportResult } from "@/lib/data";
import { sha256Hex } from "@/lib/hash";
import {
  csvErrorMessages,
  dataErrorMessages,
  fileErrorMessage,
  rowErrorLabels,
  rowWarningLabels,
} from "@/lib/messages";
import { cn } from "@/lib/utils";

type Step =
  | { name: "select"; error: string | null }
  | { name: "review"; fileName: string; analysis: ImportAnalysis }
  | { name: "done"; result: ImportResult; imported: number };

const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

/** Les exports Excel français sont parfois en Windows-1252 : on essaie UTF-8 strict d'abord. */
async function readText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1252").decode(buffer);
  }
}

export function ImportPage() {
  const { challengeId = "" } = useParams();
  const { client } = useAuth();
  const { state, reload } = useLoader(() => getChallenge(client, challengeId), [client, challengeId]);
  const [step, setStep] = useState<Step>({ name: "select", error: null });

  if (state.status === "loading") return <LoadingBlock label="Chargement du challenge…" />;
  if (state.status === "error") return <ErrorBlock message={dataErrorMessages[state.error]} onRetry={reload} />;
  const challenge = state.data;

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <Link
          to={`/challenges/${challenge.id}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {challenge.title}
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Importer des idées</h1>
          <p className="text-sm text-muted-foreground">
            Déposez l'export du formulaire. Le fichier est analysé sur votre ordinateur avant tout enregistrement.
          </p>
        </div>
        <Stepper current={step.name} />
      </header>

      {step.name === "select" && (
        <FileStep
          error={step.error}
          onAnalyzed={(fileName, analysis) => setStep({ name: "review", fileName, analysis })}
          onError={error => setStep({ name: "select", error })}
        />
      )}
      {step.name === "review" && (
        <ReviewStep
          challengeId={challenge.id}
          fileName={step.fileName}
          analysis={step.analysis}
          onBack={() => setStep({ name: "select", error: null })}
          onDone={(result, imported) => setStep({ name: "done", result, imported })}
        />
      )}
      {step.name === "done" && <DoneStep challengeId={challenge.id} result={step.result} imported={step.imported} />}
    </div>
  );
}

function Stepper({ current }: { current: Step["name"] }) {
  const steps: { key: Step["name"]; label: string }[] = [
    { key: "select", label: "Fichier" },
    { key: "review", label: "Analyse" },
    { key: "done", label: "Enregistrement" },
  ];
  const index = steps.findIndex(s => s.key === current);
  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm" aria-label="Étapes de l'import">
      {steps.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          <span
            aria-current={i === index ? "step" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-full px-3 py-1",
              i === index && "bg-primary text-primary-foreground",
              i < index && "bg-muted text-foreground",
              i > index && "text-muted-foreground",
            )}
          >
            <span className="tabular-nums">{i + 1}.</span> {s.label}
          </span>
          {i < steps.length - 1 && <span className="h-px w-6 bg-border" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

// ---------- Étape 1 : fichier ----------

function FileStep({
  error,
  onAnalyzed,
  onError,
}: {
  error: string | null;
  onAnalyzed: (fileName: string, analysis: ImportAnalysis) => void;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleFile = async (file: File | undefined) => {
    if (!file || busy) return;
    const check = checkFile(file);
    if (!check.ok) return onError(csvErrorMessages[check.error]);
    setBusy(true);
    try {
      const table = parseCsvText(await readText(file));
      if (!table.ok) return onError(csvErrorMessages[table.error]);
      const analysis = analyzeImport(table.value);
      if (!analysis.ok) return onError(fileErrorMessage(analysis.error));
      if (analysis.value.rowsRead === 0) return onError("Ce fichier ne contient aucune idée sous la ligne d'en-tête.");
      onAnalyzed(file.name, analysis.value);
    } catch {
      onError("Le fichier n'a pas pu être lu. Vérifiez qu'il n'est pas ouvert dans un autre logiciel puis réessayez.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void handleFile(e.dataTransfer.files[0]);
  };

  return (
    <div className="space-y-4">
      <div
        onDragOver={e => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center rounded-xl border-2 border-dashed bg-background px-6 py-14 text-center transition-colors",
          dragging ? "border-indigo-400 bg-indigo-50/60" : "border-border",
        )}
      >
        <span className="flex size-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100">
          {busy ? <LoaderCircle className="size-6 animate-spin" aria-hidden /> : <FileUp className="size-6" aria-hidden />}
        </span>
        <p className="mt-4 font-medium">{busy ? "Analyse du fichier…" : "Glissez votre fichier CSV ici"}</p>
        <p className="mt-1 text-sm text-muted-foreground">ou</p>
        <Button className="mt-3" variant="outline" onClick={() => inputRef.current?.click()} disabled={busy}>
          Choisir un fichier
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          aria-label="Choisir le fichier CSV des idées"
          onChange={e => void handleFile(e.target.files?.[0])}
        />
        <p className="mt-6 max-w-md text-xs text-muted-foreground text-pretty">
          Format attendu : CSV (séparateur point-virgule ou virgule), 5 Mo maximum. Colonnes obligatoires : identifiant,
          titre, description.
        </p>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}

// ---------- Étape 2 : analyse ----------

function ReviewStep({
  challengeId,
  fileName,
  analysis,
  onBack,
  onDone,
}: {
  challengeId: string;
  fileName: string;
  analysis: ImportAnalysis;
  onBack: () => void;
  onDone: (result: ImportResult, imported: number) => void;
}) {
  const { client } = useAuth();
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byRef = useMemo(() => new Map(analysis.ideas.map(i => [i.externalRef, i])), [analysis]);
  const keptCount = analysis.ideas.length - excluded.size;
  const warningGroups = useMemo(() => {
    const groups = new Map<RowWarningCode, string[]>();
    for (const idea of analysis.ideas)
      for (const w of idea.warnings) groups.set(w, [...(groups.get(w) ?? []), idea.externalRef]);
    return [...groups].sort((a, b) => b[1].length - a[1].length);
  }, [analysis]);

  const toggle = (ref: string) =>
    setExcluded(prev => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });

  const save = async () => {
    if (saving || keptCount === 0) return;
    setSaving(true);
    setError(null);
    const hashes = new Map<string, string>();
    for (const idea of analysis.ideas) {
      const key = contentKey(idea.title, idea.description);
      if (!hashes.has(key)) hashes.set(key, await sha256Hex(key));
    }
    const payload = buildImportPayload(analysis, excluded, key => hashes.get(key)!);
    const result = await importIdeas(client, challengeId, fileName, payload);
    setSaving(false);
    if (!result.ok) {
      setError(dataErrorMessages[result.error]);
      return;
    }
    onDone(result.value, payload.ideas.length);
  };

  return (
    <div className="space-y-8 pb-24">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <FileSpreadsheet className="size-4" aria-hidden />
        <span className="truncate">{fileName}</span>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Idées lues" value={analysis.rowsRead} />
        <Stat label="Prêtes à importer" value={analysis.ideas.length} tone="success" />
        <Stat label="Lignes rejetées" value={analysis.rejected.length} tone={analysis.rejected.length ? "error" : undefined} />
        <Stat
          label="Doublons possibles"
          value={analysis.duplicates.length}
          tone={analysis.duplicates.length ? "warning" : undefined}
        />
      </dl>

      {(analysis.emptyLines.length > 0 || analysis.ignoredColumns.length > 0) && (
        <Alert tone="info">
          {analysis.emptyLines.length > 0 && (
            <p>
              {analysis.emptyLines.length} ligne{analysis.emptyLines.length > 1 ? "s" : ""} vide
              {analysis.emptyLines.length > 1 ? "s" : ""} ignorée{analysis.emptyLines.length > 1 ? "s" : ""} (ligne
              {analysis.emptyLines.length > 1 ? "s" : ""} {analysis.emptyLines.join(", ")}).
            </p>
          )}
          {analysis.ignoredColumns.length > 0 && (
            <p>Colonnes non reconnues, non importées : {analysis.ignoredColumns.join(", ")}.</p>
          )}
        </Alert>
      )}

      {analysis.rejected.length > 0 && (
        <Section
          icon={<CircleAlert className="size-4 text-destructive" aria-hidden />}
          title="Lignes qui ne seront pas importées"
          subtitle="Corrigez-les dans le fichier puis réimportez-le : les idées déjà enregistrées seront mises à jour, pas dupliquées."
        >
          <ul className="divide-y rounded-lg border bg-background text-sm">
            {analysis.rejected.map(r => (
              <li key={r.line} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
                <span className="font-mono text-xs text-muted-foreground">Ligne {r.line}</span>
                <span className="font-medium">{r.externalRef ?? "Sans identifiant"}</span>
                {r.title && <span className="truncate text-muted-foreground">« {r.title} »</span>}
                <span className="text-destructive">
                  {r.errors.map(e => rowErrorLabels[e]).join(" · ")}
                  {r.firstLine ? ` (ligne ${r.firstLine})` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {analysis.duplicates.length > 0 && (
        <Section
          icon={<Copy className="size-4 text-amber-600" aria-hidden />}
          title="Doublons possibles"
          subtitle="Rien n'est fusionné automatiquement. Vous pouvez écarter une idée maintenant ; sinon, les paires seront à trancher à l'étape « Doublons »."
        >
          <ul className="space-y-3">
            {analysis.duplicates.map(d => (
              <li key={`${d.refA}-${d.refB}`} className="rounded-lg border bg-background p-4">
                <p className="mb-3">
                  <span
                    className={cn(
                      "rounded-full px-2.5 py-0.5 text-xs font-medium",
                      d.kind === "exact" ? "bg-red-50 text-red-700 ring-1 ring-red-200" : "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
                    )}
                  >
                    {d.kind === "exact" ? "Contenu identique" : `Formulation proche · ${Math.round(d.similarity * 100)} %`}
                  </span>
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {[d.refA, d.refB].map(ref => {
                    const idea = byRef.get(ref)!;
                    const isExcluded = excluded.has(ref);
                    return (
                      <div key={ref} className={cn("space-y-2 rounded-md bg-muted/50 p-3", isExcluded && "opacity-50")}>
                        <p className="text-xs text-muted-foreground">
                          {ref} · {[idea.direction, idea.site].filter(Boolean).join(", ") || "—"}
                        </p>
                        <p className="text-sm font-medium">{idea.title}</p>
                        <p className="line-clamp-3 text-sm text-muted-foreground">{idea.description}</p>
                        <Button variant="ghost" size="sm" className="-ml-2 h-8" onClick={() => toggle(ref)}>
                          {isExcluded ? "Réintégrer cette idée" : "Ne pas importer celle-ci"}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {warningGroups.length > 0 && (
        <Section
          icon={<TriangleAlert className="size-4 text-amber-600" aria-hidden />}
          title="Points d'attention"
          subtitle="Ces idées seront importées ; les points sont conservés pour la suite de l'évaluation."
        >
          <ul className="divide-y rounded-lg border bg-background text-sm">
            {warningGroups.map(([code, refs]) => (
              <li key={code} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
                <span>{rowWarningLabels[code]}</span>
                <span className="text-muted-foreground">
                  {refs.length} idée{refs.length > 1 ? "s" : ""} : {refs.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        icon={<CircleCheck className="size-4 text-emerald-600" aria-hidden />}
        title="Idées à importer"
        subtitle="Décochez une idée pour ne pas l'importer."
      >
        <IdeaPreviewTable ideas={analysis.ideas} excluded={excluded} onToggle={toggle} />
      </Section>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Button variant="ghost" onClick={onBack} disabled={saving}>
            <ArrowLeft className="size-4" aria-hidden />
            Changer de fichier
          </Button>
          <Button onClick={save} disabled={saving || keptCount === 0}>
            {saving && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
            {saving ? "Enregistrement…" : `Importer ${keptCount} idée${keptCount > 1 ? "s" : ""}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" | "error" | "warning" }) {
  return (
    <div className="rounded-xl border bg-background p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          tone === "success" && "text-emerald-700",
          tone === "error" && "text-destructive",
          tone === "warning" && "text-amber-700",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function Section({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 font-medium">
          {icon}
          {title}
        </h2>
        <p className="text-sm text-muted-foreground text-pretty">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

function IdeaPreviewTable({
  ideas,
  excluded,
  onToggle,
}: {
  ideas: AnalyzedIdea[];
  excluded: Set<string>;
  onToggle: (ref: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-background">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="w-10 px-4 py-2.5">
              <span className="sr-only">Importer</span>
            </th>
            <th className="px-2 py-2.5 font-medium">Idée</th>
            <th className="px-2 py-2.5 font-medium">Direction · site</th>
            <th className="px-2 py-2.5 font-medium">Thème</th>
            <th className="px-4 py-2.5 text-right font-medium">Budget</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {ideas.map(i => {
            const isExcluded = excluded.has(i.externalRef);
            return (
              <tr key={i.externalRef} className={cn(isExcluded && "bg-muted/40 text-muted-foreground")}>
                <td className="px-4 py-2.5 align-top">
                  <input
                    type="checkbox"
                    className="size-4 accent-zinc-900"
                    checked={!isExcluded}
                    onChange={() => onToggle(i.externalRef)}
                    aria-label={`Importer ${i.externalRef} — ${i.title}`}
                  />
                </td>
                <td className="px-2 py-2.5 align-top">
                  <p className={cn("font-medium", isExcluded && "line-through")}>{i.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {i.externalRef}
                    {i.warnings.length > 0 && (
                      <span className="text-amber-700"> · {i.warnings.map(w => rowWarningLabels[w]).join(", ")}</span>
                    )}
                  </p>
                </td>
                <td className="px-2 py-2.5 align-top">{[i.direction, i.site].filter(Boolean).join(" · ") || "—"}</td>
                <td className="px-2 py-2.5 align-top">{i.theme ?? "—"}</td>
                <td className="px-4 py-2.5 text-right align-top tabular-nums" title={i.budgetRaw ?? undefined}>
                  {i.budgetEur !== null ? euro.format(i.budgetEur) : <span className="text-muted-foreground">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Étape 3 : terminé ----------

function DoneStep({ challengeId, result, imported }: { challengeId: string; result: ImportResult; imported: number }) {
  return (
    <div className="flex flex-col items-center rounded-xl border bg-background px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100">
        <CircleCheck className="size-6" aria-hidden />
      </span>
      <h2 className="mt-4 text-lg font-semibold">
        {imported} idée{imported > 1 ? "s" : ""} enregistrée{imported > 1 ? "s" : ""}
      </h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground text-pretty">
        {result.inserted} nouvelle{result.inserted > 1 ? "s" : ""}, {result.updated} mise
        {result.updated > 1 ? "s" : ""} à jour
        {result.duplicates_added > 0 &&
          ` · ${result.duplicates_added} paire${result.duplicates_added > 1 ? "s" : ""} de doublons à examiner`}
        .
      </p>
      <Button asChild className="mt-6">
        <Link to={`/challenges/${challengeId}`}>Voir les idées</Link>
      </Button>
    </div>
  );
}
