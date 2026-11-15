import { LoaderCircle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";

export function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-16 text-sm text-muted-foreground" role="status" aria-live="polite">
      <LoaderCircle className="size-5 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="space-y-4 py-6">
      <Alert tone="error">{message}</Alert>
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          Réessayer
        </Button>
      )}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="flex flex-col items-center rounded-xl border border-dashed bg-background px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Icon className="size-6 text-muted-foreground" aria-hidden />
      </span>
      <h2 className="mt-4 text-base font-medium">{title}</h2>
      <div className="mt-1 max-w-md text-sm text-muted-foreground text-pretty">{children}</div>
      {action && <div className="mt-6">{action}</div>}
    </section>
  );
}
