import { useState } from "react";
import { Outlet } from "react-router";
import { AppName } from "@/components/AppName";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/AuthProvider";

export function AppShell() {
  const { state, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const email = state.status === "authenticated" ? state.session.user.email : undefined;

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="flex h-10 shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-4">
        <AppName asLink />
        <div className="flex min-w-0 items-center gap-3">
          {email && (
            <span className="hidden max-w-64 truncate text-xs text-muted-foreground sm:block" title={email}>
              {email}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={handleSignOut} disabled={signingOut}>
            {signingOut ? "Déconnexion…" : "Se déconnecter"}
          </Button>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
