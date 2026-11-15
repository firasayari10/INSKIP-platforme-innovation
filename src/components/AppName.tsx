import { Link } from "react-router";

/** Nom de l'application, en texte seul. */
export function AppName({ asLink = false }: { asLink?: boolean }) {
  const content = (
    <>
      <span className="text-sm font-semibold text-foreground">Challenge Innovation</span>
      <span className="mx-2 h-4 w-px bg-border" aria-hidden />
      <span className="text-xs text-muted-foreground">Espace évaluateur</span>
    </>
  );
  return asLink ? (
    <Link to="/" className="flex items-center whitespace-nowrap rounded-sm hover:underline">
      {content}
    </Link>
  ) : (
    <div className="flex items-center whitespace-nowrap">{content}</div>
  );
}
