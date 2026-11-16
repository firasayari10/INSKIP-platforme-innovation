-- =============================================================================
-- Migration : inscription libre réservée aux domaines autorisés
-- -----------------------------------------------------------------------------
-- L'inscription libre (e-mail + mot de passe, adresse confirmée par Supabase)
-- n'est permise qu'aux adresses d'un domaine listé dans
-- public.signup_allowed_domains (domaine initial : inskip.fr). Les invitations
-- envoyées par l'administrateur restent possibles pour n'importe quelle
-- adresse. Les comptes existants ne sont ni modifiés ni revalidés.
--
-- Principes (cf. CLAUDE.md §4 et §7) :
--   * la règle vit en base (trigger sur auth.users) : le pré-contrôle du
--     formulaire (public.signup_domain_allowed) n'est qu'un confort, pas une
--     garantie ;
--   * la liste des domaines n'est lisible par aucun client (RLS sans
--     politique, aucun privilège pour anon/authenticated) ;
--   * correspondance EXACTE du domaine : « evil.inskip.fr » ou
--     « inskip.fr.evil.com » ne sont pas « inskip.fr ».
--
-- Pourquoi trois triggers et non un seul BEFORE INSERT :
--   Supabase Auth crée un invité en DEUX temps dans la même transaction :
--   INSERT de l'utilisateur (invited_at encore NULL), puis UPDATE qui pose
--   invited_at (cf. sendInvite dans supabase/auth). Un contrôle « invited_at
--   is null » au moment de l'INSERT refuserait donc toute invitation vers un
--   domaine non autorisé. D'où :
--     1. _insert (BEFORE INSERT) : refus immédiat d'une inscription PAR MOT DE
--        PASSE vers un domaine non autorisé (une invitation n'a jamais de mot
--        de passe à sa création). Refus avant tout envoi d'e-mail ;
--     2. _commit (contrainte DIFFÉRÉE, vérifiée à la validation de la
--        transaction) : à ce moment, un nouvel utilisateur hors domaine doit
--        avoir été invité (invited_at non nul), sinon refus. Couvre les autres
--        voies de création sans mot de passe (lien magique/OTP, OAuth, compte
--        anonyme, création admin sans invitation) ;
--     3. _update (BEFORE UPDATE OF email) : un compte jamais invité ne peut
--        pas passer à une adresse hors domaine (s'inscrire en @inskip.fr puis
--        changer d'adresse).
--
-- Idempotence : « if not exists », « create or replace », « on conflict do
-- nothing », « drop ... if exists » avant chaque trigger.
-- =============================================================================

-- Les triggers prennent un verrou court sur auth.users : on abandonne plutôt
-- que de bloquer les connexions derrière une longue requête.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- -----------------------------------------------------------------------------
-- 1. Table des domaines autorisés
-- -----------------------------------------------------------------------------

-- Un domaine par ligne, en minuscules, sans point final ni « @ ».
-- Format : étiquettes de 1 à 63 caractères [a-z0-9-] (pas de tiret en début ni
-- en fin), au moins un point, extension commençant par une lettre.
create table if not exists public.signup_allowed_domains (
  domain     text primary key,
  created_at timestamptz not null default now(),
  constraint signup_allowed_domains_domain_lowercase
    check (domain = lower(domain)),
  constraint signup_allowed_domains_domain_format
    check (
      char_length(domain) <= 253
      and domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
    )
);

-- RLS activée sans aucune politique : aucun accès par l'API (anon,
-- authenticated). PAS de FORCE : les fonctions SECURITY DEFINER ci-dessous
-- lisent la table en tant que propriétaire ; avec FORCE elles ne verraient
-- plus rien et toute inscription serait refusée.
alter table public.signup_allowed_domains enable row level security;

insert into public.signup_allowed_domains (domain)
values ('inskip.fr')
on conflict (domain) do nothing;

-- -----------------------------------------------------------------------------
-- 2. Pré-contrôle : le domaine d'une adresse est-il autorisé ?
--    Domaine = partie après le DERNIER « @ », après trim + lower.
--    NULL, chaîne vide, sans « @ » ou domaine vide → false (jamais NULL).
--    SECURITY DEFINER : lit la table sans l'exposer ; ne révèle qu'un booléen.
-- -----------------------------------------------------------------------------
create or replace function public.signup_domain_allowed(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.signup_allowed_domains d
    where d.domain = substring(lower(trim(p_email)) from '@([^@]+)$')
  );
$$;

-- -----------------------------------------------------------------------------
-- 3. Fonction de trigger sur auth.users
--    SECURITY DEFINER : Supabase Auth écrit avec son propre rôle, qui n'a aucun
--    droit sur public.signup_allowed_domains.
-- -----------------------------------------------------------------------------
create or replace function public.enforce_signup_domain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email      text;
  v_invited_at timestamptz;
begin
  -- 1. Inscription par mot de passe : refus immédiat hors domaine.
  if tg_when = 'BEFORE' and tg_op = 'INSERT' then
    if new.invited_at is null
       and coalesce(new.encrypted_password, '') <> ''
       and not public.signup_domain_allowed(new.email) then
      raise exception 'signup_domain_not_allowed' using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- 2. Changement d'adresse d'un compte jamais invité.
  if tg_when = 'BEFORE' and tg_op = 'UPDATE' then
    if new.email is distinct from old.email
       and old.invited_at is null
       and new.invited_at is null
       and not public.signup_domain_allowed(new.email) then
      raise exception 'signup_domain_not_allowed' using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- 3. Contrôle différé (AFTER INSERT, à la validation de la transaction) :
  --    on relit l'état COURANT de la ligne, l'invitation ayant pu poser
  --    invited_at après l'INSERT.
  select u.email, u.invited_at
    into v_email, v_invited_at
  from auth.users u
  where u.id = new.id;

  if found
     and v_invited_at is null
     and not public.signup_domain_allowed(v_email) then
    raise exception 'signup_domain_not_allowed' using errcode = 'P0001';
  end if;
  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Triggers (ne s'appliquent qu'aux écritures futures : aucune ligne
--    existante n'est revalidée ni modifiée)
-- -----------------------------------------------------------------------------
drop trigger if exists auth_users_enforce_signup_domain_insert on auth.users;
create trigger auth_users_enforce_signup_domain_insert
  before insert on auth.users
  for each row execute function public.enforce_signup_domain();

drop trigger if exists auth_users_enforce_signup_domain_update on auth.users;
create trigger auth_users_enforce_signup_domain_update
  before update of email on auth.users
  for each row execute function public.enforce_signup_domain();

drop trigger if exists auth_users_enforce_signup_domain_commit on auth.users;
create constraint trigger auth_users_enforce_signup_domain_commit
  after insert on auth.users
  deferrable initially deferred
  for each row execute function public.enforce_signup_domain();

-- -----------------------------------------------------------------------------
-- 5. Privilèges
--    Supabase accorde par défaut ALL à anon/authenticated sur les nouvelles
--    tables et EXECUTE à PUBLIC sur les fonctions : on repart de zéro.
-- -----------------------------------------------------------------------------
revoke all on table public.signup_allowed_domains from public, anon, authenticated;

-- Pré-contrôle du formulaire d'inscription (avant connexion → anon).
revoke all on function public.signup_domain_allowed(text) from public, anon, authenticated;
grant execute on function public.signup_domain_allowed(text) to anon, authenticated;

-- Fonction de trigger : jamais appelable directement.
revoke all on function public.enforce_signup_domain() from public, anon, authenticated;

reset statement_timeout;
reset lock_timeout;
