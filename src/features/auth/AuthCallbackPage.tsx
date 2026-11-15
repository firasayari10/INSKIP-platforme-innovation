import type { AuthError, SupabaseClient } from "@supabase/supabase-js";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { Alert } from "@/components/Alert";
import { buttonVariants } from "@/components/ui/button";
import { classifyAuthError, safeRedirectPath, type AuthErrorCode } from "@/domain/auth";
import { authErrorMessages } from "@/lib/messages";
import { AuthLayout } from "./AuthLayout";
import { useAuth } from "./AuthProvider";

/**
 * Un code PKCE n'est échangeable qu'une fois. On mémorise la promesse par code pour que le
 * double montage de React (StrictMode) ne déclenche pas un second échange voué à l'échec.
 */
const exchanges = new Map<string, Promise<{ error: AuthError | null }>>();
function exchangeOnce(client: SupabaseClient, code: string) {
  let pending = exchanges.get(code);
  if (!pending) {
    pending = client.auth.exchangeCodeForSession(code).then(({ error }) => ({ error }));
    exchanges.set(code, pending);
  }
  return pending;
}

/** Page d'arrivée du lien magique : /auth/callback?code=…&next=… */
export function AuthCallbackPage() {
  const { state, client } = useAuth();
  const [params] = useSearchParams();
  const next = safeRedirectPath(params.get("next"));
  const code = params.get("code");
  const providerError = params.get("error_code") ?? params.get("error");

  const [failure, setFailure] = useState<AuthErrorCode | null>(() => {
    if (providerError) return classifyAuthError({ code: providerError }, "exchange_link") ?? "link_invalid_or_expired";
    if (!code) return "link_invalid_or_expired";
    return null;
  });

  useEffect(() => {
    if (!code || providerError) return;
    let active = true;
    exchangeOnce(client, code).then(({ error }) => {
      if (active && error) setFailure(classifyAuthError(error, "exchange_link") ?? "link_invalid_or_expired");
    });
    return () => {
      active = false;
    };
  }, [client, code, providerError]);

  // Session établie (y compris si elle l'était déjà) : on retire le code de l'URL en redirigeant.
  if (state.status === "authenticated") return <Navigate to={next} replace />;

  return (
    <AuthLayout>
      {failure ? (
        <div className="space-y-6">
          <header className="space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight">Connexion impossible</h2>
          </header>
          <Alert tone="error">{authErrorMessages[failure]}</Alert>
          <Link to={next === "/" ? "/connexion" : `/connexion?next=${encodeURIComponent(next)}`} className={buttonVariants({ className: "h-11 w-full" })}>
            Recevoir un nouveau lien
          </Link>
        </div>
      ) : (
        <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status" aria-live="polite">
          <LoaderCircle className="size-5 animate-spin" aria-hidden />
          Connexion en cours…
        </div>
      )}
    </AuthLayout>
  );
}
