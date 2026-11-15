import { Copy, FileUp, Lightbulb, ShieldCheck, Sparkles, Trophy } from "lucide-react";
import type { ReactNode } from "react";

const steps = [
  { Icon: FileUp, title: "Importer", text: "Déposez l'export du formulaire, les idées sont prêtes en quelques secondes." },
  { Icon: Sparkles, title: "Noter", text: "L'IA propose une note justifiée sur chaque critère, vous gardez le dernier mot." },
  { Icon: Copy, title: "Dédoublonner", text: "Les idées proches sont repérées pour vous, vous décidez." },
  { Icon: Trophy, title: "Présenter", text: "Une shortlist claire, prête à être envoyée au jury." },
];

export function BrandMark({ inverted = false }: { inverted?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={
          inverted
            ? "flex size-9 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15"
            : "flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"
        }
      >
        <Lightbulb className="size-5" aria-hidden />
      </span>
      <span className="leading-tight">
        <span className="block text-[15px] font-semibold tracking-tight">Challenge Innovation</span>
        <span className={inverted ? "block text-xs text-white/60" : "block text-xs text-muted-foreground"}>
          Espace évaluateur
        </span>
      </span>
    </div>
  );
}

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* Panneau de présentation (masqué sur petit écran) */}
      <aside className="relative hidden overflow-hidden bg-zinc-950 text-white lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-32 -top-32 size-[28rem] rounded-full bg-indigo-500/25 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-40 -left-24 size-[26rem] rounded-full bg-amber-400/10 blur-3xl"
        />

        <div className="relative">
          <BrandMark inverted />
        </div>

        <div className="relative max-w-md space-y-10">
          <div className="space-y-3">
            <h1 className="text-3xl font-semibold leading-tight tracking-tight text-balance">
              Des idées des équipes à la shortlist du jury, sans perdre le fil.
            </h1>
            <p className="text-white/65 text-pretty">
              Un seul endroit pour importer, évaluer de façon cohérente et sélectionner les meilleures idées.
            </p>
          </div>

          <ol className="space-y-5">
            {steps.map(({ Icon, title, text }, i) => (
              <li key={title} className="flex gap-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.07] ring-1 ring-white/10">
                  <Icon className="size-4 text-indigo-200" aria-hidden />
                </span>
                <div>
                  <p className="text-sm font-medium">
                    <span className="mr-1.5 text-white/40">{i + 1}.</span>
                    {title}
                  </p>
                  <p className="text-sm text-white/55">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <p className="relative flex items-center gap-2 text-xs text-white/45">
          <ShieldCheck className="size-4" aria-hidden />
          Accès réservé aux évaluateurs invités. Connexion sans mot de passe.
        </p>
      </aside>

      {/* Zone du formulaire */}
      <main className="flex flex-col px-4 py-8 sm:px-8 lg:px-16">
        <div className="lg:hidden">
          <BrandMark />
        </div>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-sm">{children}</div>
        </div>
        <p className="text-center text-xs text-muted-foreground">
          Un problème pour vous connecter ? Contactez l'administrateur de la plateforme.
        </p>
      </main>
    </div>
  );
}
