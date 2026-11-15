import type { ReactNode } from "react";

/** Barre d'état sous la grille : comptes, filtres, recherche et tri à gauche ; information de l'écran à droite. */
export function StatusBar({ count, details, right }: { count: string; details: string[]; right?: ReactNode }) {
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 overflow-hidden border-t border-border bg-muted px-2 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
      <span className="min-w-0 truncate">
        <span role="status" aria-live="polite">
          {count}
        </span>
        {details.map(d => (
          <span key={d}> · {d}</span>
        ))}
      </span>
      {right && <span className="ml-auto shrink-0">{right}</span>}
    </div>
  );
}
