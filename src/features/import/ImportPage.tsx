import { Check, ChevronRight, CircleAlert, FileUp, LoaderCircle, TriangleAlert } from "lucide-react";
import { useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { Alert } from "@/components/Alert";
import { DataGrid, emptyGridQuery } from "@/components/data-grid/DataGrid";
import type { CheckColumn, DataGridColumn } from "@/components/data-grid/types";
import { PageHeader } from "@/components/PageHeader";
import { ErrorBlock, LoadingBlock } from "@/components/PageStates";
import { Tabs } from "@/components/Tabs";
import { Button } from "@/components/ui/button";
import type { GridQuery, GridSort } from "@/domain/grid";
import {
  analyzeImport,
  buildImportPayload,
  type ImportAnalysis,
  type RejectedRow,
  type RowWarningCode,
} from "@/domain/importAnalysis";
import { contentKey } from "@/domain/text";
import { useAuth } from "@/features/auth/AuthProvider";
import { fromAnalyzedIdea, ideaColumns, ideaDefaultSort, type IdeaGridRow } from "@/features/ideas/ideaColumns";
import { useLoader } from "@/hooks/useLoader";
import { checkFile, parseCsvText } from "@/lib/csv";
import { getChallenge, importIdeas, type Challenge, type ImportResult } from "@/lib/data";
import { formatNumber, plural } from "@/lib/format";
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
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        breadcrumb={[
          { label: "Challenges", to: "/" },
          { label: challenge.title, to: `/challenges/${challenge.id}` },
          { label: "Importer un fichier" },
        ]}
        title="Importer un fichier d'idées"
      >
        <ImportSteps current={step.name} />
      </PageHeader>

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
      {step.name === "done" && (
        <DoneStep
          challenge={challenge}
          result={step.result}
          imported={step.imported}
          onAgain={() => setStep({ name: "select", error: null })}
        />
      )}
    </div>
  );
}

// ---------- Indicateur d'étapes ----------

function ImportSteps({ current }: { current: Step["name"] }) {
  const steps: { key: Step["name"]; label: string }[] = [
    { key: "select", label: "1. Choisir le fichier" },
    { key: "review", label: "2. Vérifier" },
    { key: "done", label: "3. Terminé" },
  ];
  const index = steps.findIndex(s => s.key === current);
  return (
    <ol aria-label="Étapes de l'import" className="flex flex-wrap items-center gap-2 pt-1 text-ui">
      {steps.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          {i > 0 && <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />}
          {i < index ? (
            <span className="flex items-center gap-1 text-foreground">
              <Check className="size-3.5 text-success" aria-hidden />
              {s.label}
              <span className="sr-only"> (terminée)</span>
            </span>
          ) : i === index ? (
            <span aria-current="step" className="border-b-2 border-primary pb-0.5 font-semibold text-foreground">
              {s.label}
            </span>
          ) : (
            <span className="text-muted-foreground">{s.label}</span>
          )}
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
    <div className="max-w-2xl space-y-3 px-4 pb-4">
      <div
        onDragOver={e => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "rounded-sm border border-dashed px-4 py-8",
          dragging ? "border-primary bg-selection-row" : "border-input bg-background",
        )}
      >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {busy ? (
            <>
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden />
              <span role="status">Analyse du fichier…</span>
            </>
          ) : (
            <>
              <FileUp className="size-4 text-muted-foreground" aria-hidden />
              Glissez le fichier CSV ici, ou
            </>
          )}
          <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
            Choisir un fichier…
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          tabIndex={-1}
          aria-label="Choisir le fichier CSV des idées"
          onChange={e => void handleFile(e.target.files?.[0])}
        />
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Format</dt>
        <dd>CSV, séparateur point-virgule ou virgule</dd>
        <dt className="text-muted-foreground">Taille</dt>
        <dd>5 Mo maximum</dd>
        <dt className="text-muted-foreground">Colonnes obligatoires</dt>
        <dd>identifiant, titre, description</dd>
        <dt className="text-muted-foreground">Confidentialité</dt>
        <dd>Le fichier est analysé sur votre ordinateur ; rien n'est enregistré avant votre validation.</dd>
      </dl>
    </div>
  );
}

// ---------- Étape 2 : vérifier ----------

type TabId = "ideas" | "rejected" | "duplicates" | "warnings";

interface WarningGroup {
  code: RowWarningCode;
  label: string;
  refs: string[];
}

const rejectedSort: GridSort = { key: "line", direction: "asc" };
const warningsSort: GridSort = { key: "count", direction: "desc" };

const rejectedColumns: DataGridColumn<RejectedRow>[] = [
  { key: "line", label: "Ligne du fichier", width: 96, kind: "number", value: r => r.line },
  { key: "ref", label: "Réf.", width: 112, kind: "ref", value: r => r.externalRef },
  { key: "title", label: "Titre", width: 320, kind: "text", value: r => r.title },
  {
    key: "problem",
    label: "Problème",
    width: 360,
    kind: "text",
    value: r => problemText(r),
    render: r => <span className="text-destructive">{problemText(r)}</span>,
  },
];

function problemText(r: RejectedRow): string {
  return r.errors.map(e => rowErrorLabels[e]).join(" ; ") + (r.firstLine ? ` (voir ligne ${r.firstLine})` : "");
}

const countSegment = (n: number, one: string, many: string) => (n > 0 ? plural(n, one, many) : null);

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
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>(analysis.ideas.length > 0 ? "ideas" : "rejected");
  const [ideasQuery, setIdeasQuery] = useState<GridQuery>(emptyGridQuery);
  const [rejectedQuery, setRejectedQuery] = useState<GridQuery>(emptyGridQuery);
  const [warningsQuery, setWarningsQuery] = useState<GridQuery>(emptyGridQuery);

  const rows = useMemo(() => analysis.ideas.map(fromAnalyzedIdea), [analysis]);
  const keptCount = analysis.ideas.length - excluded.size;
  const warningGroups = useMemo<WarningGroup[]>(() => {
    const groups = new Map<RowWarningCode, string[]>();
    for (const idea of analysis.ideas)
      for (const w of idea.warnings) groups.set(w, [...(groups.get(w) ?? []), idea.externalRef]);
    return [...groups].map(([code, refs]) => ({ code, label: rowWarningLabels[code], refs }));
  }, [analysis]);

  const setChecked = (refs: readonly string[], checked: boolean) =>
    setExcluded(prev => {
      const next = new Set(prev);
      for (const ref of refs) {
        if (checked) next.delete(ref);
        else next.add(ref);
      }
      return next;
    });
  const toggle = (ref: string) => setChecked([ref], excluded.has(ref));

  const checkColumn: CheckColumn<IdeaGridRow> = {
    label: "Importer",
    headerLabel: "Tout importer (lignes affichées)",
    width: 40,
    isChecked: r => !excluded.has(r.ref),
    onToggle: r => toggle(r.ref),
    onToggleAll: (shown, checked) => setChecked(shown.map(r => r.ref), checked),
    ariaLabel: r => `Importer ${r.ref} — ${r.title}`,
  };

  const showWarning = (code: RowWarningCode) => {
    setIdeasQuery(q => ({ ...q, search: "", filters: { flags: new Set([code]) } }));
    setTab("ideas");
  };

  const warningColumns: DataGridColumn<WarningGroup>[] = [
    { key: "label", label: "Point d'attention", width: 320, kind: "text", value: g => g.label },
    { key: "count", label: "Idées", width: 72, kind: "number", value: g => g.refs.length },
    { key: "refs", label: "Réf. concernées", width: 360, kind: "text", value: g => g.refs.join(", ") },
    {
      key: "action",
      label: "Action",
      width: 140,
      kind: "text",
      sortable: false,
      searchable: false,
      value: () => null,
      text: () => "Afficher ces idées",
      render: g => (
        <Button variant="link" tabIndex={-1} onClick={() => showWarning(g.code)}>
          Afficher ces idées
        </Button>
      ),
    },
  ];

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

  const linesRead = analysis.rowsRead + analysis.emptyLines.length;
  const summary = `${plural(keptCount, "idée sera importée", "idées seront importées")} sur ${formatNumber(analysis.rowsRead)}`;
  const fileLine = [
    `Fichier : ${fileName}`,
    countSegment(linesRead, "ligne lue", "lignes lues"),
    analysis.emptyLines.length > 0
      ? `${plural(analysis.emptyLines.length, "ligne vide ignorée", "lignes vides ignorées")} (${analysis.emptyLines.length > 1 ? "lignes" : "ligne"} ${analysis.emptyLines.join(", ")})`
      : null,
    analysis.ignoredColumns.length > 0 ? `Colonnes non importées : ${analysis.ignoredColumns.join(", ")}` : null,
  ].filter((s): s is string => s !== null);

  // Nombre d'idées portant au moins un point d'attention.
  const warningCount = analysis.ideas.filter(i => i.warnings.length > 0).length;
  const tabLabel = (label: string, count: number, tone: "error" | "warning" | null) => (
    <>
      {count > 0 && tone === "error" && <CircleAlert className="size-3.5 text-destructive" aria-hidden />}
      {count > 0 && tone === "warning" && <TriangleAlert className="size-3.5 text-warning" aria-hidden />}
      {label}{" "}
      <span
        className={cn("tabular-nums", count > 0 && tone === "error" && "text-destructive", count > 0 && tone === "warning" && "text-warning")}
      >
        ({formatNumber(count)})
      </span>
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="px-4 pb-2 text-xs text-muted-foreground">{fileLine.join(" · ")}</p>

      {analysis.rejected.length > 0 && (
        <Alert
          tone="error"
          className="mx-4 mb-2"
          action={
            <Button variant="link" onClick={() => setTab("rejected")}>
              Voir les lignes rejetées
            </Button>
          }
        >
          {plural(analysis.rejected.length, "ligne ne sera pas importée", "lignes ne seront pas importées")}. Corrigez-les
          dans le fichier puis réimportez-le : les idées déjà enregistrées seront mises à jour, pas dupliquées.
        </Alert>
      )}

      <Tabs
        label="Résultat de la vérification"
        value={tab}
        onChange={id => setTab(id as TabId)}
        className="mx-4"
        panelClassName="mx-4 mb-3 flex min-h-0 flex-1 flex-col"
        items={[
          { id: "ideas", label: tabLabel("Idées à importer", analysis.ideas.length, null), disabled: analysis.ideas.length === 0 },
          { id: "rejected", label: tabLabel("Lignes rejetées", analysis.rejected.length, "error"), disabled: analysis.rejected.length === 0 },
          {
            id: "duplicates",
            label: tabLabel("Doublons possibles", analysis.duplicates.length, "warning"),
            disabled: analysis.duplicates.length === 0,
          },
          { id: "warnings", label: tabLabel("Points d'attention", warningCount, "warning"), disabled: warningCount === 0 },
        ]}
      >
        {tab === "ideas" && (
          <DataGrid<IdeaGridRow>
            className="border-t-0"
            label="Idées à importer"
            rows={rows}
            columns={ideaColumns}
            rowKey={r => r.ref}
            rowLabel={r => r.ref}
            query={ideasQuery}
            onQueryChange={setIdeasQuery}
            defaultSort={ideaDefaultSort}
            checkColumn={checkColumn}
            rowClassName={r => (excluded.has(r.ref) ? "text-muted-foreground" : undefined)}
            searchLabel="Rechercher dans les idées"
            countLabel={n => plural(n, "idée", "idées")}
            shownLabel={n => plural(n, "affichée", "affichées")}
            noMatchLabel="Aucune idée ne correspond à la recherche ou aux filtres."
            emptyBody={<p>Aucune ligne du fichier ne peut être importée.</p>}
            statusRight={() => summary}
          />
        )}
        {tab === "rejected" && (
          <DataGrid<RejectedRow>
            className="border-t-0"
            label="Lignes rejetées"
            rows={analysis.rejected}
            columns={rejectedColumns}
            rowKey={r => String(r.line)}
            rowLabel={r => `Ligne ${r.line}`}
            query={rejectedQuery}
            onQueryChange={setRejectedQuery}
            defaultSort={rejectedSort}
            searchLabel="Rechercher dans les lignes rejetées"
            countLabel={n => plural(n, "ligne rejetée", "lignes rejetées")}
            shownLabel={n => plural(n, "affichée", "affichées")}
            noMatchLabel="Aucune ligne ne correspond à la recherche."
            emptyBody={<p>Aucune ligne rejetée.</p>}
          />
        )}
        {tab === "duplicates" && <DuplicatesTable analysis={analysis} excluded={excluded} onToggle={toggle} />}
        {tab === "warnings" && (
          <>
            <p className="py-2 text-xs text-muted-foreground">
              Ces idées seront importées ; les points sont conservés pour la suite de l'évaluation.
            </p>
            <DataGrid<WarningGroup>
              label="Points d'attention"
              rows={warningGroups}
              columns={warningColumns}
              rowKey={g => g.code}
              rowLabel={g => plural(g.refs.length, "idée", "idées")}
              query={warningsQuery}
              onQueryChange={setWarningsQuery}
              defaultSort={warningsSort}
              onOpenRow={g => showWarning(g.code)}
              searchLabel="Rechercher dans les points d'attention"
              countLabel={n => plural(n, "point d'attention", "points d'attention")}
              shownLabel={n => plural(n, "affiché", "affichés")}
              noMatchLabel="Aucun point d'attention ne correspond à la recherche."
              emptyBody={<p>Aucun point d'attention.</p>}
            />
          </>
        )}
      </Tabs>

      {error && (
        <Alert tone="error" className="mx-4 mb-2">
          {error}
        </Alert>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border bg-muted px-4 py-2">
        <Button variant="outline" onClick={onBack} disabled={saving}>
          Changer de fichier
        </Button>
        <span className="ml-auto text-ui text-muted-foreground">{summary}</span>
        <Button onClick={save} disabled={saving || keptCount === 0}>
          {saving && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
          {saving ? "Enregistrement…" : `Importer ${plural(keptCount, "idée", "idées")}`}
        </Button>
      </div>
    </div>
  );
}

const cell = "h-7 max-w-0 truncate border-r border-b border-grid px-2 align-middle whitespace-nowrap";
const headCell = "sticky top-0 z-10 h-7 border-r border-b border-border bg-grid-header px-2 text-left text-xs font-semibold";

/** Paires de doublons possibles : deux lignes par paire, case « Importer » synchronisée avec l'onglet principal. */
function DuplicatesTable({
  analysis,
  excluded,
  onToggle,
}: {
  analysis: ImportAnalysis;
  excluded: ReadonlySet<string>;
  onToggle: (ref: string) => void;
}) {
  const byRef = useMemo(() => new Map(analysis.ideas.map(i => [i.externalRef, i])), [analysis]);
  const widths = [40, 96, 240, 360, 140, 120];
  return (
    <>
      <p className="py-2 text-xs text-muted-foreground">
        Rien n'est fusionné automatiquement. Décochez une idée pour ne pas l'importer ; sinon, la paire sera à trancher à
        l'étape Doublons.
      </p>
      <div className="min-h-0 flex-1 overflow-auto border border-border bg-background">
        <table className="w-max min-w-full table-fixed border-separate border-spacing-0 text-ui">
          <colgroup>
            {widths.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={headCell}>
                <span className="sr-only">Importer</span>
              </th>
              <th scope="col" className={headCell}>
                Réf.
              </th>
              <th scope="col" className={headCell}>
                Titre
              </th>
              <th scope="col" className={headCell}>
                Extrait de la description
              </th>
              <th scope="col" className={headCell}>
                Direction
              </th>
              <th scope="col" className={headCell}>
                Site
              </th>
            </tr>
          </thead>
          {analysis.duplicates.map((d, i) => (
            <tbody key={`${d.refA}-${d.refB}`}>
              <tr>
                <th scope="colgroup" colSpan={widths.length} className="h-7 border-b border-grid bg-muted px-2 text-left text-xs font-semibold">
                  Paire {i + 1} ·{" "}
                  {d.kind === "exact" ? "Contenu identique" : `Formulation proche (${Math.round(d.similarity * 100)} %)`}
                </th>
              </tr>
              {[d.refA, d.refB].map(ref => {
                const idea = byRef.get(ref);
                if (!idea) return null;
                const isExcluded = excluded.has(ref);
                return (
                  <tr key={ref} className={cn("hover:bg-row-hover", isExcluded && "text-muted-foreground")}>
                    <td className={cn(cell, "text-center")}>
                      <input
                        type="checkbox"
                        className="size-3.5 align-middle"
                        checked={!isExcluded}
                        onChange={() => onToggle(ref)}
                        aria-label={`Importer ${ref} — ${idea.title}`}
                      />
                    </td>
                    <td className={cell}>{ref}</td>
                    <td className={cell} title={idea.title}>
                      {idea.title}
                    </td>
                    <td className={cn(cell, "py-1 align-top whitespace-normal")}>
                      <span className="line-clamp-3">{idea.description}</span>
                    </td>
                    <EmptyableCell value={idea.direction} />
                    <EmptyableCell value={idea.site} />
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </>
  );
}

function EmptyableCell({ value }: { value: string | null }): ReactNode {
  return (
    <td className={cell} title={value ?? undefined}>
      {value ?? <span className="sr-only">Vide</span>}
    </td>
  );
}

// ---------- Étape 3 : terminé ----------

function DoneStep({
  challenge,
  result,
  imported,
  onAgain,
}: {
  challenge: Challenge;
  result: ImportResult;
  imported: number;
  onAgain: () => void;
}) {
  const lines: [string, number][] = [
    ["Nouvelles idées", result.inserted],
    ["Idées mises à jour", result.updated],
    ...(result.duplicates_added > 0 ? [["Paires de doublons à examiner", result.duplicates_added] as [string, number]] : []),
  ];
  return (
    <div className="max-w-2xl space-y-3 px-4 pb-4">
      <Alert tone="success" title={plural(imported, "idée enregistrée", "idées enregistrées")}>
        Le fichier a été importé dans le challenge {challenge.title}.
      </Alert>
      <table className="border-separate border-spacing-0 text-ui">
        <tbody>
          {lines.map(([label, n]) => (
            <tr key={label}>
              <th scope="row" className="h-7 border-b border-grid pr-6 text-left font-normal">
                {label}
              </th>
              <td className="h-7 border-b border-grid text-right tabular-nums">{formatNumber(n)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex gap-2">
        <Button asChild>
          <Link to={`/challenges/${challenge.id}`}>Voir les idées</Link>
        </Button>
        <Button variant="outline" onClick={onAgain}>
          Importer un autre fichier
        </Button>
      </div>
    </div>
  );
}
