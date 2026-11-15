import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { publicConfig } from "./config";

/**
 * Client Supabase unique du navigateur.
 * - flux PKCE : le lien magique n'est utilisable que dans le navigateur qui l'a demandé ;
 * - l'accès aux données reste filtré par la RLS côté base (la clé publishable n'ouvre rien seule).
 * `null` si la configuration est absente ou dangereuse : l'app affiche alors un écran dédié.
 */
export const supabase: SupabaseClient | null = publicConfig.ok
  ? createClient(publicConfig.value.supabaseUrl, publicConfig.value.supabasePublishableKey, {
      auth: {
        flowType: "pkce",
        persistSession: true,
        autoRefreshToken: true,
        // Échange du code fait explicitement par /auth/callback pour en maîtriser les erreurs.
        detectSessionInUrl: false,
      },
    })
  : null;
