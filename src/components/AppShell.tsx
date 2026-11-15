import { LogOut } from "lucide-react";
import { useState } from "react";
import { Outlet } from "react-router";
import { CreditBadge } from "@/components/CreditBadge";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/features/auth/AuthLayout";
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
    <div className="min-h-screen bg-muted/30">
      <header className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <BrandMark />
          <div className="flex min-w-0 items-center gap-3">
            <CreditBadge />
            {email && (
              <span className="hidden truncate text-sm text-muted-foreground sm:block" title={email}>
                {email}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={handleSignOut} disabled={signingOut}>
              <LogOut className="size-4" aria-hidden />
              Se déconnecter
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
