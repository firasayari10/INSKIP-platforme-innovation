import { Alert } from "@/components/Alert";
import type { ConfigError } from "@/lib/config";
import { configErrorMessages } from "@/lib/messages";

/** Affiché quand l'application ne peut pas démarrer en sécurité (configuration absente ou dangereuse). */
export function ConfigErrorScreen({ error }: { error: ConfigError }) {
  return (
    <div className="flex min-h-dvh justify-center bg-muted px-4 pt-[12vh]">
      <div className="w-full max-w-[360px]">
        <div className="space-y-4 rounded-sm border border-border bg-background p-6">
          <h1 className="text-lg font-semibold">L'application n'est pas disponible</h1>
          <Alert tone="error" title={configErrorMessages[error]}>
            Contactez l'administrateur de la plateforme. Aucune donnée n'a été affectée.
          </Alert>
        </div>
      </div>
    </div>
  );
}
