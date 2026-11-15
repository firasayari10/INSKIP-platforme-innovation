import type { ReactNode } from "react";
import { AppName } from "@/components/AppName";

/** Mise en page des écrans de connexion : en-tête d'application et une boîte de formulaire. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-muted">
      <header className="flex h-10 shrink-0 items-center border-b border-border bg-background px-4">
        <AppName />
      </header>
      <main className="flex flex-1 justify-center px-4 pt-[12vh]">
        <div className="w-full max-w-[360px]">
          <div className="rounded-sm border border-border bg-background p-6">{children}</div>
          <p className="mt-3 text-xs text-muted-foreground">
            Accès réservé aux évaluateurs invités. Un problème pour vous connecter ? Contactez l'administrateur de la
            plateforme.
          </p>
        </div>
      </main>
    </div>
  );
}
