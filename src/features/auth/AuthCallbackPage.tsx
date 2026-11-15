import type { AuthError, SupabaseClient } from "@supabase/supabase-js";
import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation, useSearchParams } from "react-router";
import { Alert } from "@/components/Alert";
import { buttonVariants } from "@/components/ui/button";
import {
  classifyAuthError,
  parseCallbackParams,
  safeRedirectPath,
  type AuthErrorCode,
  type CallbackParams,
} from "@/domain/auth";
import { authErrorMessages } from "@/lib/messages";
import { AuthLayout } from "./AuthLayout";
import { useAuth } from "./AuthProvider";

type Verifiable = Extract<CallbackParams, { kind: "token_hash" | "code" }>;

/**
 * Un jeton reçu par e-mail n'est utilisable qu'une fois. On mémorise la vérification par jeton
 * pour que le double montage de React (StrictMode) ne déclenche pas un second appel voué à l'échec.
 */
const verifications = new Map<string, Promise<{ error: AuthError | null }>>();
function verifyOnce(client: SupabaseClient, params: Verifiable) {
  const key = params.kind === "code" ? `code:${params.code}` : `hash:${params.tokenHash}`;
  let pending = verifications.get(key);
  if (!pending) {
    pending = (
      params.kind === "code"
        ? client.auth.exchangeCodeForSession(params.code)
        : client.auth.verifyOtp({ token_hash: params.tokenHash, type: params.type })
    ).then(({ error }) => ({ error }));
    verifications.set(key, pending);
  }
  return pending;
}

/** Page d'arrivée des liens de connexion et d'invitation : /auth/callback?… */
export function AuthCallbackPage() {
  const { state, client } = useAuth();
  const location = useLocation();
  const [query] = useSearchParams();
  const next = safeRedirectPath(query.get("next"));
  const params = useMemo(() => parseCallbackParams(location.search, location.hash), [location.search, location.hash]);

  const [failure, setFailure] = useState<AuthErrorCode | null>(() => {
    if (params.kind === "error") return classifyAuthError({ code: params.code }, "exchange_link") ?? "link_invalid_or_expired";
    if (params.kind === "invalid") return "link_invalid_or_expired";
    return null;
  });

  useEffect(() => {
    if (params.kind !== "code" && params.kind !== "token_hash") return;
    let active = true;
    verifyOnce(client, params).then(({ error }) => {
      if (active && error) setFailure(classifyAuthError(error, "exchange_link") ?? "link_invalid_or_expired");
    });
    return () => {
      active = false;
    };
  }, [client, params]);

  // Session établie : on quitte la page, ce qui retire aussi le jeton de l'URL.
  if (state.status === "authenticated") return <Navigate to={next} replace />;

  return (
    <AuthLayout>
      {failure ? (
        <div className="space-y-4">
          <h1 className="text-lg font-semibold">Connexion impossible</h1>
          <Alert tone="error">{authErrorMessages[failure]}</Alert>
          <Link
            to={next === "/" ? "/connexion" : `/connexion?next=${encodeURIComponent(next)}`}
            className={buttonVariants({ size: "lg", className: "w-full" })}
          >
            Recevoir un nouveau lien
          </Link>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          Connexion en cours…
        </div>
      )}
    </AuthLayout>
  );
}
