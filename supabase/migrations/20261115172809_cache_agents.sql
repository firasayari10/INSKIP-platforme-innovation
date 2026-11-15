-- =============================================================================
-- Migration : cache des sorties d'agents IA (ADR 0003, §1 et §7 « M-A »)
-- -----------------------------------------------------------------------------
-- Ajoute :
--   * agent_outputs : la sortie validée d'un appel d'agent (analyste,
--     consultant, associé, économique), retrouvée par l'empreinte SHA-256 de
--     la requête exacte envoyée au modèle. Une requête identique dans le même
--     challenge réutilise la sortie au lieu de rappeler le fournisseur ;
--   * evaluations.input_fingerprint : empreinte SHA-256 de toutes les entrées
--     d'une évaluation, pour le court-circuit « évaluation entière » (remplace
--     la comparaison content_hash + JSON.stringify(models)).
--
-- Principes (cf. CLAUDE.md §4, §5 et §7, ADR 0003 §1, mêmes choix que les
-- migrations précédentes) :
--   * le challenge est la frontière d'isolation : une sortie n'est retrouvée
--     que par (challenge_id, fingerprint), jamais d'un challenge à l'autre, et
--     disparaît avec son challenge (cascade) ;
--   * agent_outputs est un cache INTERNE au serveur (api/, rôle service_role) :
--     aucun droit pour anon ni authenticated, RLS activée sans aucune
--     politique (refus total même si un privilège était accordé par erreur).
--     Le navigateur lit les résultats via evaluations et criterion_assessments ;
--   * cache en ajout seul : service_role lit et insère (« on conflict do
--     nothing »), sans UPDATE ni DELETE. Une sortie ne peut donc pas être
--     retouchée après coup ; une purge future se fera par une migration ou une
--     fonction dédiée (index sur created_at prévu pour elle) ;
--   * aucune donnée d'auteur : les messages envoyés aux agents n'en contiennent
--     pas (ADR 0002), leurs sorties non plus.
--
-- Idempotence : « if not exists », « drop ... if exists » : rejouable sans
-- effet de bord.
-- =============================================================================

-- Verrous courts (ajout de colonne et d'index sur evaluations, FK vers
-- challenges) : on abandonne plutôt que de bloquer la file d'attente.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- -----------------------------------------------------------------------------
-- 1. Table du cache des sorties d'agents
-- -----------------------------------------------------------------------------

-- Sortie validée (schéma zod) d'un appel d'agent.
-- agent : rôle de l'agent ; criterion_key : clé du critère évalué, présente
-- pour un consultant (un consultant par critère) et seulement pour lui.
-- Pas de FK vers criteria : l'empreinte inclut déjà la définition complète du
-- critère, et une sortie doit rester réutilisable si un critère est supprimé
-- puis recréé à l'identique.
-- fingerprint : SHA-256 (hexadécimal minuscule) du JSON canonique de la
-- requête (fournisseur, modèle, paramètres, schéma, messages initiaux).
-- output : sortie de l'agent (objet JSON, 60 000 octets au plus).
-- citations : sources web citées (tableau, 30 au plus).
-- usage : jetons consommés et coût de l'appel d'origine (objet).
create table if not exists public.agent_outputs (
  id             uuid primary key default gen_random_uuid(),
  challenge_id   uuid not null references public.challenges (id) on delete cascade,
  agent          text not null
                 check (agent in ('analyste', 'consultant', 'associe', 'economique')),
  criterion_key  text check (criterion_key ~ '^[a-z_]{2,40}$'),
  fingerprint    text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  prompt_version text not null check (char_length(prompt_version) between 1 and 20),
  model          text not null check (char_length(model) between 1 and 120),
  output         jsonb not null
                 check (jsonb_typeof(output) = 'object'
                        and octet_length(output::text) <= 60000),
  citations      jsonb not null default '[]'::jsonb
                 check (jsonb_typeof(citations) = 'array'
                        and jsonb_array_length(citations) <= 30),
  usage          jsonb not null default '{}'::jsonb
                 check (jsonb_typeof(usage) = 'object'),
  created_at     timestamptz not null default now(),
  -- Nom distinct du check de colonne sur criterion_key (nommé automatiquement
  -- agent_outputs_criterion_key_check par PostgreSQL).
  constraint agent_outputs_consultant_criterion_check
    check ((agent = 'consultant') = (criterion_key is not null)),
  -- Clé de recherche du cache ; sert aussi la FK challenge_id (cascade).
  constraint agent_outputs_challenge_id_fingerprint_key
    unique (challenge_id, fingerprint)
);

-- Purge future des entrées les plus anciennes (AGENT_CACHE_MAX_AGE_DAYS).
create index if not exists agent_outputs_created_at_idx
  on public.agent_outputs (created_at);

-- -----------------------------------------------------------------------------
-- 2. Empreinte des entrées d'une évaluation
--    Colonne nullable sans défaut : ajout instantané (pas de réécriture) ;
--    les anciennes lignes restent à NULL et ne sont jamais réutilisées. Le
--    check parcourt la table une fois, sous verrou (quelques milliers de lignes
--    au plus, toutes à NULL).
--    Privilèges : authenticated a déjà SELECT sur toute la table et
--    service_role SELECT, INSERT, UPDATE sur toute la table (migration
--    notation_par_agents) ; ces droits de niveau table couvrent la nouvelle
--    colonne.
-- -----------------------------------------------------------------------------

alter table public.evaluations
  add column if not exists input_fingerprint text
  constraint evaluations_input_fingerprint_format_check
    check (input_fingerprint ~ '^[0-9a-f]{64}$');

-- Court-circuit : dernière évaluation terminée de cette idée avec les mêmes
-- entrées. Partiel : seules les évaluations terminées sont réutilisables.
-- Index ordinaire (pas CONCURRENTLY, le fichier s'exécute dans une
-- transaction) : bloque les écritures sur evaluations le temps de la
-- construction, quelques millisecondes à cette volumétrie.
create index if not exists evaluations_idea_id_input_fingerprint_idx
  on public.evaluations (idea_id, input_fingerprint)
  where status = 'completed';

-- -----------------------------------------------------------------------------
-- 3. Privilèges
--    Supabase accorde par défaut ALL à anon, authenticated et service_role sur
--    les nouvelles tables : on repart de zéro et on accorde le strict
--    nécessaire.
-- -----------------------------------------------------------------------------

revoke all on table public.agent_outputs
from anon, authenticated, service_role, public;

-- service_role (serveur de notation, api/) : lit et alimente le cache. Ni
-- UPDATE ni DELETE : une sortie mise en cache n'est jamais retouchée.
grant select, insert on public.agent_outputs to service_role;

-- -----------------------------------------------------------------------------
-- 4. Row Level Security (mêmes choix que les migrations précédentes : pas de
--    FORCE). Aucune politique : tout accès de anon ou authenticated est
--    refusé, même si un privilège venait à être accordé. service_role
--    contourne la RLS (BYPASSRLS) et n'est limité que par ses privilèges.
-- -----------------------------------------------------------------------------

alter table public.agent_outputs enable row level security;

reset statement_timeout;
reset lock_timeout;
