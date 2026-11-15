import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AppShell } from "@/components/AppShell";
import { ConfigErrorScreen } from "@/components/ConfigErrorScreen";
import { AuthCallbackPage } from "@/features/auth/AuthCallbackPage";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { LoginPage } from "@/features/auth/LoginPage";
import { RequireAuth } from "@/features/auth/RequireAuth";
import { ChallengesPage } from "@/features/challenges/ChallengesPage";
import { ChallengePage } from "@/features/ideas/ChallengePage";
import { IdeaPage } from "@/features/ideas/IdeaPage";
import { ImportPage } from "@/features/import/ImportPage";
import { publicConfig } from "@/lib/config";
import { supabase } from "@/lib/supabase";
import "./index.css";

export function App() {
  if (!publicConfig.ok || !supabase) {
    return <ConfigErrorScreen error={publicConfig.ok ? "missing" : publicConfig.error} />;
  }

  return (
    <AuthProvider client={supabase}>
      <BrowserRouter>
        <Routes>
          <Route path="/connexion" element={<LoginPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route element={<RequireAuth />}>
            <Route element={<AppShell />}>
              <Route index element={<ChallengesPage />} />
              <Route path="challenges/:challengeId" element={<ChallengePage />} />
              <Route path="challenges/:challengeId/import" element={<ImportPage />} />
              <Route path="challenges/:challengeId/idees/:ideaId" element={<IdeaPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
