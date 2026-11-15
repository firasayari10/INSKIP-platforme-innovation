import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface TabItem {
  id: string;
  label: ReactNode;
  disabled?: boolean;
}

/**
 * Onglets accessibles (motif « tablist » avec activation automatique) : flèches gauche/droite,
 * Début/Fin ; un onglet désactivé reste visible mais n'est pas atteignable.
 */
export function Tabs({
  items,
  value,
  onChange,
  label,
  className,
  panelClassName,
  children,
}: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  className?: string;
  panelClassName?: string;
  /** Contenu de l'onglet actif. */
  children: ReactNode;
}) {
  const base = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const enabled = items.filter(t => !t.disabled);

  const select = (id: string) => {
    onChange(id);
    refs.current.get(id)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = enabled.findIndex(t => t.id === value);
    let next: TabItem | undefined;
    if (e.key === "ArrowRight") next = enabled[(index + 1) % enabled.length];
    else if (e.key === "ArrowLeft") next = enabled[(index - 1 + enabled.length) % enabled.length];
    else if (e.key === "Home") next = enabled[0];
    else if (e.key === "End") next = enabled.at(-1);
    if (!next) return;
    e.preventDefault();
    select(next.id);
  };

  return (
    <>
      <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className={cn("flex border-b border-border", className)}>
        {items.map(t => {
          const selected = t.id === value;
          return (
            <button
              key={t.id}
              ref={el => {
                if (el) refs.current.set(t.id, el);
                else refs.current.delete(t.id);
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              disabled={t.disabled}
              onClick={() => onChange(t.id)}
              className={cn(
                "-mb-px flex h-8 items-center gap-1.5 rounded-t-sm border border-b-0 border-transparent px-3 text-ui whitespace-nowrap",
                selected
                  ? "border-border bg-background font-semibold text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
                t.disabled && "pointer-events-none opacity-50",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${base}-panel-${value}`}
        aria-labelledby={`${base}-tab-${value}`}
        className={panelClassName}
      >
        {children}
      </div>
    </>
  );
}
