import { LogOut } from "lucide-react";
import { useState } from "react";
import { Link, Outlet } from "react-router";
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
      <header className="sticky top-0 z-10 border-b-2 border-brand-lime bg-brand-navy text-white print:hidden">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link to="/" aria-label="Accueil : vos challenges" className="rounded-md focus-visible:outline-2 focus-visible:outline-brand-lime">
            <BrandMark inverted />
          </Link>
          <div className="flex min-w-0 items-center gap-3">
            <CreditBadge />
            {email && (
              <span className="hidden truncate text-sm text-white/70 sm:block" title={email}>
                {email}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleSignOut}
              disabled={signingOut}
              className="border-white/25 bg-transparent text-white hover:bg-white/10 hover:text-white"
            >
              <LogOut className="size-4" aria-hidden />
              Se déconnecter
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 print:max-w-none print:p-0">
        <Outlet />
      </main>
    </div>
  );
}
