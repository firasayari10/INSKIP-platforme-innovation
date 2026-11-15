import { FolderOpen } from "lucide-react";

/** Accueil connecté. Les challenges arrivent avec la feature d'import. */
export function ChallengesPage() {
  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Vos challenges</h1>
        <p className="text-sm text-muted-foreground">Retrouvez ici les challenges d'innovation que vous évaluez.</p>
      </header>

      <section className="flex flex-col items-center rounded-xl border border-dashed bg-background px-6 py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-muted">
          <FolderOpen className="size-6 text-muted-foreground" aria-hidden />
        </span>
        <h2 className="mt-4 text-base font-medium">Aucun challenge pour le moment</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground text-pretty">
          Dès qu'un challenge sera créé, vous pourrez y importer les idées des équipes et commencer l'évaluation.
        </p>
      </section>
    </div>
  );
}
