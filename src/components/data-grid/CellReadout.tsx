/** Zone de lecture : affiche en entier le contenu de la cellule active (barre de contenu d'un tableur). */
export function CellReadout({
  rowLabel,
  columnLabel,
  text,
  flags,
}: {
  rowLabel: string | null;
  columnLabel: string | null;
  text: string;
  flags: string[];
}) {
  return (
    <div className="flex min-h-7 shrink-0 border-b border-border text-ui" aria-live="off">
      <div className="w-24 shrink-0 truncate border-r border-border bg-muted px-2 py-1 font-semibold tabular-nums">
        {rowLabel}
      </div>
      <div className="min-w-0 flex-1 px-2 py-1 break-words whitespace-pre-wrap">
        {columnLabel !== null && (
          <>
            {columnLabel} : {text}
            {flags.length > 0 && <span className="text-warning"> · Point d'attention : {flags.join(" ; ")}</span>}
          </>
        )}
      </div>
    </div>
  );
}
