import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const styles = {
  error: { box: "border-destructive-border bg-destructive-bg", Icon: CircleAlert, icon: "text-destructive" },
  warning: { box: "border-warning-border bg-warning-bg", Icon: TriangleAlert, icon: "text-warning" },
  success: { box: "border-success-border bg-success-bg", Icon: CircleCheck, icon: "text-success" },
  info: { box: "border-border bg-muted", Icon: Info, icon: "text-muted-foreground" },
} as const;

export function Alert({
  tone,
  title,
  children,
  action,
  className,
}: {
  tone: keyof typeof styles;
  title?: string;
  children: ReactNode;
  /** Commande affichée à droite du message (ex. « Réessayer »). */
  action?: ReactNode;
  className?: string;
}) {
  const { box, Icon, icon } = styles[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("flex gap-2 rounded-sm border px-3 py-2 text-sm text-foreground", box, className)}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", icon)} aria-hidden />
      <div className="min-w-0 space-y-0.5">
        {title && <p className="font-semibold">{title}</p>}
        <div>{children}</div>
      </div>
      {action && <div className="ml-auto shrink-0 self-center">{action}</div>}
    </div>
  );
}
