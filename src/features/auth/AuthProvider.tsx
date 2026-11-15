import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type AuthState =
  | { status: "loading"; session: null }
  | { status: "anonymous"; session: null }
  | { status: "authenticated"; session: Session };

interface AuthContextValue {
  state: AuthState;
  client: SupabaseClient;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ client, children }: { client: SupabaseClient; children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading", session: null });

  useEffect(() => {
    let active = true;
    const apply = (session: Session | null) => {
      if (!active) return;
      setState(session ? { status: "authenticated", session } : { status: "anonymous", session: null });
    };

    // onAuthStateChange émet INITIAL_SESSION au démarrage : une seule source de vérité.
    const { data } = client.auth.onAuthStateChange((_event, session) => apply(session));
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [client]);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      client,
      signOut: async () => {
        // « local » : ne déconnecte que ce navigateur ; la session est révoquée côté serveur.
        await client.auth.signOut({ scope: "local" });
      },
    }),
    [state, client],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth doit être utilisé dans <AuthProvider>.");
  return ctx;
}
