-- =============================================================================
-- Migration : conversations avec l'assistant IA sur la fiche d'une idée
-- -----------------------------------------------------------------------------
-- Ajoute :
--   * idea_chat_messages : les messages échangés entre l'évaluateur et
--     l'assistant IA sur une idée (explication de la note, apport
--     d'informations, comparaison avec d'autres idées citées par @IDEA-xxx),
--     conservés pour la traçabilité du conseil ;
--   * evaluations.evaluator_notes : informations apportées par l'évaluateur
--     dans la conversation et transmises aux agents lors d'une réévaluation.
--
-- Principes (cf. CLAUDE.md §4, §5 et §7, mêmes choix que les migrations
-- précédentes) :
--   * le challenge reste la frontière d'isolation : le message porte
--     challenge_id et ses références passent par des FK composites (une
--     idée du même challenge, une évaluation de la MÊME idée) ;
--   * le serveur (api/, rôle service_role) écrit les DEUX types de messages,
--     après avoir vérifié l'appartenance de l'appelant en lisant l'idée avec
--     SON jeton (RLS). Le navigateur ne fait que lire : authenticated n'a
--     aucun droit d'écriture, un utilisateur ne peut donc ni fabriquer une
--     réponse de l'IA ni réécrire l'historique ;
--   * historique conservé : ni authenticated ni service_role ne peuvent
--     supprimer un message ; seul service_role peut en modifier une colonne
--     (used_for_evaluation_id, rattachement à une réévaluation). Un message
--     ne disparaît qu'avec son idée (cascade) ;
--   * service_role contourne la RLS (BYPASSRLS) : ses droits sont limités par
--     les privilèges au strict besoin du serveur.
--
-- Idempotence : « if not exists », « create or replace », « drop ... if
-- exists » : rejouable sans effet de bord.
-- =============================================================================

-- Verrous courts (ajout de colonne sur evaluations, FK vers ideas,
-- evaluations et auth.users) : on abandonne plutôt que de bloquer la file
-- d'attente.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- -----------------------------------------------------------------------------
-- 1. Informations de l'évaluateur transmises aux agents
--    Colonne nullable sans défaut : ajout instantané (pas de réécriture). Le
--    check parcourt la table une fois (quelques centaines de lignes au plus).
--    Privilèges : authenticated a déjà SELECT sur toute la table et
--    service_role SELECT, INSERT, UPDATE sur toute la table (migration
--    précédente) ; ces droits de niveau table couvrent la nouvelle colonne.
-- -----------------------------------------------------------------------------

alter table public.evaluations
  add column if not exists evaluator_notes text
  constraint evaluations_evaluator_notes_length_check
    check (char_length(evaluator_notes) <= 8000);

-- -----------------------------------------------------------------------------
-- 2. Table des messages
-- -----------------------------------------------------------------------------

-- Un message de la conversation sur une idée.
-- author_id : l'évaluateur qui a écrit le message (role = 'user'), renseigné
-- par le serveur avec l'identifiant vérifié du JWT ; NULL pour une réponse de
-- l'assistant. ON DELETE SET NULL : la suppression d'un compte (droit à
-- l'effacement) ne bloque pas et ne supprime pas l'historique du conseil.
-- Conséquence : la règle « un message utilisateur a un auteur » ne peut être
-- vérifiée qu'À L'INSERTION (trigger ci-dessous) ; le check permanent ne porte
-- que sur « une réponse de l'assistant n'a pas d'auteur », qui reste vraie
-- après un SET NULL.
-- referenced_refs : identifiants external_ref cités par @IDEA-xxx (10 au plus,
-- sans NULL, 640 caractères au total : 10 × 64, la taille maximale de
-- ideas.external_ref).
-- used_for_evaluation_id : la réévaluation qui a pris ce message en compte ;
-- la FK composite garantit qu'il s'agit d'une évaluation de la MÊME idée.
-- model : modèle IA ayant produit la réponse (traçabilité, CLAUDE.md §5.7) ;
-- obligatoire pour une réponse de l'assistant, absent pour un message
-- utilisateur.
create table if not exists public.idea_chat_messages (
  id                     uuid primary key default gen_random_uuid(),
  challenge_id           uuid not null,
  idea_id                uuid not null,
  role                   text not null check (role in ('user', 'assistant')),
  author_id              uuid references auth.users (id) on delete set null,
  content                text not null check (char_length(content) between 1 and 8000),
  referenced_refs        text[] not null default '{}'
                         check (cardinality(referenced_refs) <= 10
                                and array_position(referenced_refs, null) is null
                                and char_length(array_to_string(referenced_refs, '')) <= 640),
  used_for_evaluation_id uuid,
  model                  text check (char_length(model) between 1 and 120),
  created_at             timestamptz not null default now(),
  constraint idea_chat_messages_assistant_author_check
    check (role = 'user' or author_id is null),
  -- Nom distinct du check de colonne sur model (nommé automatiquement
  -- idea_chat_messages_model_check par PostgreSQL).
  constraint idea_chat_messages_model_role_check
    check ((role = 'assistant') = (model is not null)),
  constraint idea_chat_messages_idea_fkey
    foreign key (challenge_id, idea_id)
    references public.ideas (challenge_id, id) on delete cascade,
  -- Si l'évaluation disparaît, seule la référence passe à NULL (PG 15+) :
  -- le message reste.
  constraint idea_chat_messages_evaluation_fkey
    foreign key (challenge_id, idea_id, used_for_evaluation_id)
    references public.evaluations (challenge_id, idea_id, id)
    on delete set null (used_for_evaluation_id)
);

-- Fil de discussion d'une idée, dans l'ordre ; sert aussi la cascade depuis
-- ideas (FK (challenge_id, idea_id), idea_id seul est sélectif).
create index if not exists idea_chat_messages_idea_id_created_at_idx
  on public.idea_chat_messages (idea_id, created_at);
-- Quota de messages par utilisateur sur une période ; sert aussi le SET NULL
-- à la suppression d'un compte.
create index if not exists idea_chat_messages_author_id_created_at_idx
  on public.idea_chat_messages (author_id, created_at);
-- Messages pris en compte par une réévaluation ; sert aussi le SET NULL à la
-- suppression d'une évaluation. Partiel : la plupart des messages n'en ont pas.
create index if not exists idea_chat_messages_used_for_evaluation_id_idx
  on public.idea_chat_messages (used_for_evaluation_id)
  where used_for_evaluation_id is not null;

-- -----------------------------------------------------------------------------
-- 3. Fonction et trigger : un message utilisateur a un auteur à sa création
--    Erreur 23514 (comme un check) pour que le serveur la traite de la même
--    façon. Uniquement à l'INSERT : le SET NULL ultérieur reste possible.
-- -----------------------------------------------------------------------------

create or replace function public.check_chat_message_author()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.role = 'user' and new.author_id is null then
    raise exception 'idea_chat_messages : un message utilisateur doit avoir un auteur'
      using errcode = '23514',
            constraint = 'idea_chat_messages_user_author_check';
  end if;
  return new;
end;
$$;

drop trigger if exists idea_chat_messages_check_author on public.idea_chat_messages;
create trigger idea_chat_messages_check_author
  before insert on public.idea_chat_messages
  for each row execute function public.check_chat_message_author();

-- -----------------------------------------------------------------------------
-- 4. Privilèges
--    Supabase accorde par défaut ALL à anon, authenticated et service_role sur
--    les nouvelles tables, et EXECUTE à PUBLIC sur les fonctions : on repart
--    de zéro et on accorde le strict nécessaire.
-- -----------------------------------------------------------------------------

revoke all on table public.idea_chat_messages
from anon, authenticated, service_role, public;

-- authenticated : lecture seule (filtrée par la RLS).
grant select on public.idea_chat_messages to authenticated;

-- service_role (serveur de conversation, api/) : écrit les messages, puis les
-- rattache à la réévaluation qui les a pris en compte. Pas de DELETE.
grant select, insert on public.idea_chat_messages to service_role;
grant update (used_for_evaluation_id) on public.idea_chat_messages to service_role;

revoke all on function public.check_chat_message_author()
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. Row Level Security (mêmes choix que les migrations précédentes : pas de
--    FORCE, une politique par opération, rôle authenticated uniquement).
--    SELECT seulement : l'absence de politique et de privilège d'écriture
--    refuse toute écriture cliente.
-- -----------------------------------------------------------------------------

alter table public.idea_chat_messages enable row level security;

drop policy if exists idea_chat_messages_select on public.idea_chat_messages;
create policy idea_chat_messages_select on public.idea_chat_messages
  for select to authenticated
  using (public.is_challenge_member(challenge_id));

reset statement_timeout;
reset lock_timeout;
