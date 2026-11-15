import { Alert } from "@/components/Alert";
import type { ConfigError } from "@/lib/config";
import { configErrorMessages } from "@/lib/messages";

/** Affiché quand l'application ne peut pas démarrer en sécurité (configuration absente ou dangereuse). */
export function ConfigErrorScreen({ error }: { error: ConfigError }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">L'application n'est pas disponible</h1>
        <Alert tone="error" title={configErrorMessages[error]}>
          Contactez l'administrateur de la plateforme. Aucune donnée n'a été affectée.
        </Alert>
      </div>
    </div>
  );
}
