import { CircleAlert, CircleCheck, Info } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const styles = {
  error: { box: "border-destructive/30 bg-destructive/5 text-destructive", Icon: CircleAlert },
  success: { box: "border-emerald-600/25 bg-emerald-50 text-emerald-900", Icon: CircleCheck },
  info: { box: "border-border bg-muted/60 text-foreground", Icon: Info },
} as const;

export function Alert({
  tone,
  title,
  children,
  className,
}: {
  tone: keyof typeof styles;
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  const { box, Icon } = styles[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("flex gap-3 rounded-lg border px-4 py-3 text-sm leading-relaxed", box, className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="space-y-1">
        {title && <p className="font-medium">{title}</p>}
        <div className={cn(title && "opacity-90")}>{children}</div>
      </div>
    </div>
  );
}
