import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

/** En-tête de page : fil d'Ariane, titre, métadonnées ; `children` sous le titre (étapes d'import). */
export function PageHeader({
  breadcrumb = [],
  title,
  meta,
  children,
}: {
  breadcrumb?: BreadcrumbItem[];
  title: string;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="shrink-0 space-y-1 px-4 pt-3 pb-2">
      {breadcrumb.length > 0 && (
        <nav aria-label="Fil d'Ariane" className="text-xs text-muted-foreground">
          <ol className="flex flex-wrap items-center gap-1">
            {breadcrumb.map((item, i) => {
              const last = i === breadcrumb.length - 1;
              return (
                <li key={`${i}-${item.label}`} className="flex min-w-0 items-center gap-1">
                  {i > 0 && <ChevronRight className="size-3 shrink-0" aria-hidden />}
                  {item.to && !last ? (
                    <Link to={item.to} className="truncate hover:underline">
                      {item.label}
                    </Link>
                  ) : (
                    <span className="truncate" aria-current={last ? "page" : undefined}>
                      {item.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      )}
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-lg font-semibold">{title}</h1>
        {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
      </div>
      {children}
    </div>
  );
}
