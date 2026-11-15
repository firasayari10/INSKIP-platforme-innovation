import { Navigate, Outlet, useLocation } from "react-router";
import { FullPageLoader } from "@/components/FullPageLoader";
import { useAuth } from "./AuthProvider";

/** Garde de route : tout ce qui est imbriqué exige une session valide. */
export function RequireAuth() {
  const { state } = useAuth();
  const location = useLocation();

  if (state.status === "loading") return <FullPageLoader label="Vérification de votre session…" />;

  if (state.status === "anonymous") {
    const next = `${location.pathname}${location.search}${location.hash}`;
    const query = next === "/" ? "" : `?next=${encodeURIComponent(next)}`;
    return <Navigate to={`/connexion${query}`} replace />;
  }

  return <Outlet />;
}
