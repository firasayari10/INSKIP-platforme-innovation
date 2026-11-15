import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";

export function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground" role="status" aria-live="polite">
      <LoaderCircle className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="px-4 py-3">
      <Alert
        tone="error"
        action={
          onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Réessayer
            </Button>
          )
        }
      >
        {message}
      </Alert>
    </div>
  );
}

/** État vide hors grille (dans une grille, l'état vide est un corps de grille). */
export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-sm border border-border bg-background px-4 py-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="text-sm text-muted-foreground">{children}</div>
      {action && <div className="mt-3">{action}</div>}
    </section>
  );
}
