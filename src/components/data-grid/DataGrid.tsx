import { LoaderCircle } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "@/components/ui/button";
import { applyGridQuery, filterOptions, type CellValue, type GridQuery, type GridSort } from "@/domain/grid";
import { formatDate, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CellReadout } from "./CellReadout";
import { ColumnFilterMenu } from "./ColumnFilterMenu";
import { ColumnHeader } from "./ColumnHeader";
import { GridToolbar } from "./GridToolbar";
import { StatusBar } from "./StatusBar";
import {
  firstDirection,
  isRightAligned,
  sortPhrase,
  withDefaults,
  type CheckColumn,
  type DataGridColumn,
} from "./types";

const ROW_HEIGHT = 28;
const ROW_NUMBER_WIDTH = 44;

export const emptyGridQuery = (): GridQuery => ({ search: "", filters: {}, sort: null });

export interface DataGridProps<R> {
  /** Nom accessible du tableau (« Idées du challenge »). */
  label: string;
  rows: readonly R[];
  columns: readonly DataGridColumn<R>[];
  rowKey: (row: R) => string;
  /** Tri, filtres et recherche : état de la page (perdu à la navigation). */
  query: GridQuery;
  onQueryChange: (query: GridQuery) => void;
  /** Tri appliqué sans choix de l'utilisateur, et départage des égalités. */
  defaultSort: GridSort;
  /** Libellé du chargement du corps de grille ; absent = données prêtes. */
  loadingLabel?: string;
  /** Corps affiché quand il n'y a aucune donnée (texte + action). */
  emptyBody: ReactNode;
  /** Message quand les filtres ne laissent aucune ligne. */
  noMatchLabel: string;
  /** « 40 idées » ; `shown` : « 12 affichées ». */
  countLabel: (n: number) => string;
  shownLabel: (n: number) => string;
  statusRight?: (shown: readonly R[]) => ReactNode;
  actions?: ReactNode;
  searchLabel: string;
  /** Case de gauche de la zone de lecture (Réf. de la ligne). */
  rowLabel: (row: R) => string;
  /** Entrée sur une ligne : ouvre l'élément. */
  onOpenRow?: (row: R) => void;
  rowClassName?: (row: R) => string | undefined;
  checkColumn?: CheckColumn<R>;
  className?: string;
}

type Active = { header: boolean; rowKey: string | null; col: number };

function defaultText<R>(column: DataGridColumn<R>, row: R): string {
  if (column.text) return column.text(row);
  const v: CellValue = column.value(row);
  if (v === null) return "";
  if (column.kind === "date" && typeof v === "string") return formatDate(v);
  if (typeof v === "number") return formatNumber(v);
  return v;
}

/**
 * Grille de données façon tableur : en-tête figé, numéros de ligne, colonnes gelées, tri par
 * en-tête, filtre par colonne, recherche, zone de lecture et barre d'état. Un seul arrêt de
 * tabulation ; navigation au clavier selon docs/design/direction-ui.md §4.10.
 */
export function DataGrid<R>(props: DataGridProps<R>) {
  const { rows, rowKey, query, onQueryChange, defaultSort, checkColumn } = props;
  const columns = useMemo(() => props.columns.map(withDefaults), [props.columns]);
  const displayed = useMemo(
    () => applyGridQuery(rows, columns, { ...query, defaultSort }),
    [rows, columns, query, defaultSort],
  );

  const offset = checkColumn ? 1 : 0; // index de la première colonne de données
  const colCount = columns.length + offset;
  const loading = props.loadingLabel !== undefined;
  const hasRows = !loading && displayed.length > 0;

  // ---------- Cellule active ----------
  const [active, setActive] = useState<Active>({ header: false, rowKey: null, col: offset });
  const [touched, setTouched] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const pendingFocus = useRef(false);
  const tableRef = useRef<HTMLTableElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const foundIndex = active.rowKey === null ? -1 : displayed.findIndex(r => rowKey(r) === active.rowKey);
  const rowIndex = !hasRows || active.header ? -1 : Math.max(0, foundIndex);
  const colIndex = Math.min(active.col, colCount - 1);
  const activeRow = rowIndex >= 0 ? displayed[rowIndex] : undefined;

  const moveTo = (r: number, c: number, focus = true) => {
    const row = r >= 0 ? displayed[r] : undefined;
    setActive({ header: r < 0 || !row, rowKey: row ? rowKey(row) : active.rowKey, col: c });
    setTouched(true);
    pendingFocus.current = focus;
  };

  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    const el = tableRef.current?.querySelector<HTMLElement>(`[data-cell="${rowIndex}:${colIndex}"]`);
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  // ---------- Tri et filtres ----------
  const cycleSort = (column: DataGridColumn<R>) => {
    const first = firstDirection(column.kind);
    const current = query.sort?.key === column.key ? query.sort.direction : null;
    const sort: GridSort | null =
      current === null
        ? { key: column.key, direction: first }
        : current === first
          ? { key: column.key, direction: first === "asc" ? "desc" : "asc" }
          : null;
    onQueryChange({ ...query, sort });
  };

  const setFilter = (key: string, keys: ReadonlySet<string> | null) => {
    const filters = { ...query.filters };
    if (keys) filters[key] = keys;
    else delete filters[key];
    onQueryChange({ ...query, filters });
  };

  const clearFilters = () => onQueryChange({ ...query, search: "", filters: {} });

  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const filterButtons = useRef(new Map<string, HTMLButtonElement>());
  const anchorRef = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return openFilter ? (filterButtons.current.get(openFilter) ?? null) : null;
      },
    }),
    [openFilter],
  );
  const openColumn = openFilter ? columns.find(c => c.key === openFilter) : undefined;
  const options = useMemo(
    () => (openFilter ? filterOptions(rows, columns, query, openFilter) : []),
    [openFilter, rows, columns, query],
  );

  const filterable = columns.filter(c => c.filter);
  const filteredKeys = Object.keys(query.filters).filter(k => columns.some(c => c.key === k));
  const isFiltered = filteredKeys.length > 0 || query.search.trim() !== "";

  // ---------- Clavier ----------
  const copyActive = () => {
    const column = columns[colIndex - offset];
    if (!column) return;
    const text = activeRow ? defaultText(column, activeRow) : column.label;
    void navigator.clipboard?.writeText(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    const target = e.target as HTMLElement;
    const onCell = target.dataset.cell !== undefined;
    const lastRow = hasRows ? displayed.length - 1 : -1;
    const column = columns[colIndex - offset];
    let r = rowIndex;
    let c = colIndex;

    switch (e.key) {
      case "ArrowUp":
        r = Math.max(-1, r - 1);
        break;
      case "ArrowDown":
        if (e.altKey) {
          if (rowIndex === -1 && column?.filter) {
            e.preventDefault();
            setOpenFilter(column.key);
          }
          return;
        }
        r = Math.min(lastRow, r + 1);
        break;
      case "ArrowLeft":
        c = Math.max(0, c - 1);
        break;
      case "ArrowRight":
        c = Math.min(colCount - 1, c + 1);
        break;
      case "Home":
        c = 0;
        if (e.ctrlKey) r = lastRow >= 0 ? 0 : -1;
        break;
      case "End":
        c = colCount - 1;
        if (e.ctrlKey) r = lastRow;
        break;
      case "PageUp":
      case "PageDown": {
        const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1);
        r = e.key === "PageUp" ? Math.max(rowIndex < 0 ? -1 : 0, r - page) : Math.min(lastRow, r + page);
        break;
      }
      case "Enter":
      case " ": {
        if (!onCell) return; // case à cocher ou lien : comportement natif
        e.preventDefault();
        if (checkColumn && colIndex === 0) {
          if (rowIndex === -1) checkColumn.onToggleAll(displayed, !displayed.every(checkColumn.isChecked));
          else if (activeRow && e.key === " ") checkColumn.onToggle(activeRow);
          return;
        }
        if (rowIndex === -1) {
          if (column && column.sortable !== false) cycleSort(column);
        } else if (activeRow && e.key === "Enter") props.onOpenRow?.(activeRow);
        return;
      }
      case "c":
      case "C":
        if ((e.ctrlKey || e.metaKey) && !window.getSelection()?.toString()) {
          e.preventDefault();
          copyActive();
        }
        return;
      default:
        return;
    }
    e.preventDefault();
    moveTo(r, c);
  };

  const onFocusIn = () => setFocusWithin(true);
  const onFocusOut = (e: FocusEvent<HTMLTableElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
  };

  // ---------- Mise en page ----------
  const widths = [...(checkColumn ? [checkColumn.width] : []), ...columns.map(c => c.width)];
  const frozenFlags = [...(checkColumn ? [true] : []), ...columns.map(c => !!c.frozen)];
  const lefts: number[] = [];
  let left = ROW_NUMBER_WIDTH;
  widths.forEach((w, i) => {
    lefts.push(left);
    if (frozenFlags[i]) left += w;
  });
  const lastFrozen = frozenFlags.lastIndexOf(true);
  const frozenStyle = (i: number) => (frozenFlags[i] ? { left: lefts[i] } : undefined);

  const activeOutline = cn("outline-2 -outline-offset-2", focusWithin ? "outline-ring" : "outline-input");
  const activeColumn = columns[colIndex - offset];

  // ---------- Barre d'état ----------
  const sortSegment = (() => {
    const s = query.sort ?? defaultSort;
    const column = columns.find(c => c.key === s.key);
    return column ? `Tri : ${column.label}, ${sortPhrase(column.kind, s.direction)}` : null;
  })();
  const details = [
    filteredKeys.length > 0
      ? `Filtres : ${filteredKeys.map(k => columns.find(c => c.key === k)?.label ?? k).join(", ")}`
      : null,
    query.search.trim() !== "" ? `Recherche : « ${query.search.trim()} »` : null,
    sortSegment,
  ].filter((d): d is string => d !== null);
  const count = loading
    ? (props.loadingLabel ?? "")
    : isFiltered
      ? `${props.countLabel(rows.length)} · ${props.shownLabel(displayed.length)}`
      : props.countLabel(rows.length);

  const cellText = activeRow && activeColumn ? defaultText(activeColumn, activeRow) : "";
  const cellFlags = activeRow && activeColumn?.cellFlags ? activeColumn.cellFlags(activeRow) : [];

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col border border-border bg-background", props.className)}>
      <GridToolbar
        actions={props.actions}
        search={query.search}
        onSearchChange={search => onQueryChange({ ...query, search })}
        searchLabel={props.searchLabel}
        filterable={filterable.map(c => ({ key: c.key, label: c.label, active: c.key in query.filters }))}
        onPickFilter={key => setOpenFilter(key)}
        onClear={clearFilters}
      />
      <CellReadout
        rowLabel={touched && activeRow ? props.rowLabel(activeRow) : null}
        columnLabel={touched && activeRow && activeColumn ? activeColumn.label : null}
        text={cellText}
        flags={cellFlags}
      />

      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-auto"
        style={{ scrollPaddingTop: ROW_HEIGHT, scrollPaddingLeft: left }}
      >
        <table
          ref={tableRef}
          role="grid"
          aria-label={props.label}
          aria-rowcount={displayed.length + 1}
          aria-colcount={colCount + 1}
          onKeyDown={onKeyDown}
          onFocus={onFocusIn}
          onBlurCapture={onFocusOut}
          className="w-max min-w-full table-fixed border-separate border-spacing-0 text-ui"
        >
          <colgroup>
            <col style={{ width: ROW_NUMBER_WIDTH }} />
            {widths.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <thead>
            <tr aria-rowindex={1}>
              <th
                scope="col"
                className="sticky top-0 left-0 z-30 h-7 border-r border-b border-border bg-muted"
                aria-label="Numéro de ligne"
              />
              {checkColumn && (
                <th
                  scope="col"
                  data-cell={`-1:0`}
                  tabIndex={rowIndex === -1 && colIndex === 0 ? 0 : -1}
                  style={frozenStyle(0)}
                  onClick={() => moveTo(-1, 0)}
                  className={cn(
                    "sticky top-0 z-30 h-7 border-r border-b border-border bg-grid-header px-2 text-center",
                    lastFrozen === 0 && "border-r-border",
                    rowIndex === -1 && colIndex === 0 && activeOutline,
                  )}
                >
                  <HeaderCheckbox
                    label={checkColumn.headerLabel}
                    checked={hasRows && displayed.every(checkColumn.isChecked)}
                    indeterminate={hasRows && displayed.some(checkColumn.isChecked) && !displayed.every(checkColumn.isChecked)}
                    disabled={!hasRows}
                    onChange={checked => checkColumn.onToggleAll(displayed, checked)}
                  />
                </th>
              )}
              {columns.map((column, i) => {
                const c = i + offset;
                const sorted = query.sort?.key === column.key ? query.sort.direction : null;
                const filtered = column.key in query.filters;
                const isActive = rowIndex === -1 && colIndex === c;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    data-cell={`-1:${c}`}
                    tabIndex={isActive ? 0 : -1}
                    aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                    style={frozenStyle(c)}
                    onClick={() => moveTo(-1, c)}
                    className={cn(
                      "sticky top-0 z-20 h-7 border-r border-b border-border bg-grid-header px-2 text-xs font-semibold text-foreground",
                      column.frozen && "z-30",
                      c === lastFrozen && "border-r-border",
                      (filtered || (activeRow !== undefined && colIndex === c)) && "bg-selection",
                      isActive && activeOutline,
                    )}
                  >
                    <ColumnHeader
                      label={column.label}
                      rightAligned={isRightAligned(column.kind)}
                      sortable={column.sortable !== false}
                      sort={sorted}
                      filterable={!!column.filter}
                      filtered={filtered}
                      filterOpen={openFilter === column.key}
                      filterButtonRef={el => {
                        if (el) filterButtons.current.set(column.key, el);
                        else filterButtons.current.delete(column.key);
                      }}
                      onSort={() => cycleSort(column)}
                      onOpenFilter={() => {
                        setActive(a => ({ ...a, header: true, col: c }));
                        setOpenFilter(o => (o === column.key ? null : column.key));
                      }}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <BodyMessage colSpan={colCount + 1}>
                <span className="flex items-center gap-2 text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" aria-hidden />
                  {props.loadingLabel}
                </span>
              </BodyMessage>
            ) : rows.length === 0 ? (
              <BodyMessage colSpan={colCount + 1}>{props.emptyBody}</BodyMessage>
            ) : displayed.length === 0 ? (
              <BodyMessage colSpan={colCount + 1}>
                <p>{props.noMatchLabel}</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={clearFilters}>
                  Effacer les filtres
                </Button>
              </BodyMessage>
            ) : (
              displayed.map((row, r) => {
                const key = rowKey(row);
                const isActiveRow = r === rowIndex;
                const rowBg = isActiveRow ? "bg-selection-row" : "bg-background group-hover:bg-row-hover";
                return (
                  <tr
                    key={key}
                    aria-rowindex={r + 2}
                    aria-selected={isActiveRow}
                    className={cn("group", props.rowClassName?.(row))}
                  >
                    <th
                      scope="row"
                      onClick={() => moveTo(r, offset)}
                      className={cn(
                        "sticky left-0 z-10 h-7 cursor-default border-r border-b border-border px-2 text-right text-xs tabular-nums",
                        isActiveRow ? "bg-selection font-semibold text-primary" : "bg-muted font-normal text-muted-foreground",
                      )}
                    >
                      {r + 1}
                    </th>
                    {checkColumn && (
                      <td
                        data-cell={`${r}:0`}
                        tabIndex={isActiveRow && colIndex === 0 ? 0 : -1}
                        style={frozenStyle(0)}
                        onClick={() => moveTo(r, 0)}
                        className={cn(
                          "sticky z-10 h-7 border-r border-b border-grid px-2 text-center align-middle",
                          rowBg,
                          lastFrozen === 0 && "border-r-border",
                          isActiveRow && colIndex === 0 && activeOutline,
                        )}
                      >
                        <input
                          type="checkbox"
                          tabIndex={-1}
                          className="size-3.5 align-middle"
                          checked={checkColumn.isChecked(row)}
                          onChange={() => checkColumn.onToggle(row)}
                          aria-label={checkColumn.ariaLabel(row)}
                        />
                      </td>
                    )}
                    {columns.map((column, i) => {
                      const c = i + offset;
                      const text = defaultText(column, row);
                      const flags = column.cellFlags?.(row) ?? [];
                      const content = column.render ? column.render(row) : text;
                      const empty = !column.render && text === "";
                      const isActive = isActiveRow && colIndex === c;
                      const title = [text, ...flags].filter(Boolean).join("\n");
                      return (
                        <td
                          key={column.key}
                          data-cell={`${r}:${c}`}
                          tabIndex={isActive ? 0 : -1}
                          title={title || undefined}
                          style={frozenStyle(c)}
                          onClick={() => moveTo(r, c)}
                          className={cn(
                            "h-7 max-w-0 truncate border-r border-b border-grid px-2 align-middle whitespace-nowrap",
                            isRightAligned(column.kind) && "text-right tabular-nums",
                            rowBg,
                            flags.length > 0 &&
                              "after:pointer-events-none after:absolute after:top-0 after:right-0 after:size-0 after:border-t-[6px] after:border-l-[6px] after:border-t-warning after:border-l-transparent",
                            flags.length > 0 && !column.frozen && "relative",
                            column.frozen && "sticky z-10",
                            c === lastFrozen && "border-r-border",
                            isActive && activeOutline,
                          )}
                        >
                          {empty ? <span className="sr-only">Vide</span> : content}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <StatusBar
        count={count}
        details={loading ? [] : details}
        right={!loading && rows.length > 0 ? props.statusRight?.(displayed) : undefined}
      />

      {openColumn && openColumn.filter && (
        <ColumnFilterMenu
          key={openColumn.key}
          open
          label={openColumn.label}
          kind={openColumn.kind}
          sortable={openColumn.sortable !== false}
          options={options}
          selected={query.filters[openColumn.key]}
          anchorRef={anchorRef}
          onSort={direction => onQueryChange({ ...query, sort: { key: openColumn.key, direction } })}
          onApply={keys => setFilter(openColumn.key, keys)}
          onClose={() => {
            const c = columns.indexOf(openColumn) + offset;
            setOpenFilter(null);
            moveTo(-1, c);
          }}
        />
      )}
    </div>
  );
}

function BodyMessage({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-4 text-left text-sm whitespace-normal">
        {/* Reste visible au défilement horizontal d'une grille plus large que l'écran. */}
        <div className="sticky left-3 max-w-2xl">{children}</div>
      </td>
    </tr>
  );
}

function HeaderCheckbox({
  label,
  checked,
  indeterminate,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      tabIndex={-1}
      className="size-3.5 align-middle"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={e => onChange(e.target.checked)}
    />
  );
}
