-- =============================================================================
-- Migration : import des idées depuis un CSV/XLSX
-- -----------------------------------------------------------------------------
-- Crée les tables nécessaires à l'import (challenges, membres, lots d'import,
-- idées, auteurs, paires de doublons), la sécurité au niveau des lignes (RLS)
-- et la fonction RPC public.import_ideas (import atomique et idempotent).
--
-- Principes (cf. CLAUDE.md §4 et §7) :
--   * le challenge est la frontière d'isolation : chaque table « fille » porte
--     challenge_id, et les références entre tables passent par des clés
--     étrangères composites (challenge_id, id) : une idée ne peut pas pointer
--     vers un lot ou une paire d'un autre challenge ;
--   * RLS activée partout, une politique par opération, rôle authenticated
--     uniquement ; anon n'a aucun droit ;
--   * les données personnelles des auteurs sont isolées dans idea_authors ;
--   * les contraintes métier vivent en base (check, unique, FK, not null).
--
-- Idempotence : « if not exists », « create or replace », « drop ... if exists »
-- avant chaque politique et trigger : la rejouer sur une base où elle est déjà
-- passée ne casse rien.
-- =============================================================================

-- La FK vers auth.users prend un verrou court sur auth.users : on ne doit pas
-- attendre derrière une longue requête (sinon les connexions s'empilent).
set lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. Fonctions utilitaires sans dépendance de table
-- -----------------------------------------------------------------------------

-- Maintient updated_at à chaque UPDATE (fonction de trigger, SECURITY INVOKER).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------

-- Challenge d'innovation d'un client.
-- created_by : ON DELETE RESTRICT. Un challenge porte un historique (imports,
-- décisions) : on ne laisse pas la suppression d'un compte le rendre orphelin
-- en silence. Pour retirer un utilisateur, transférer ou supprimer d'abord ses
-- challenges. (SET NULL est incompatible avec NOT NULL demandé.)
create table if not exists public.challenges (
  id             uuid primary key default gen_random_uuid(),
  title          text not null check (char_length(title) between 1 and 200),
  client_name    text not null check (char_length(client_name) between 1 and 200),
  jury_date      date,
  shortlist_size integer not null default 8 check (shortlist_size between 1 and 50),
  created_by     uuid not null default auth.uid()
                 references auth.users (id) on delete restrict,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists challenges_created_by_idx
  on public.challenges (created_by);

-- Membres d'un challenge (qui peut voir et travailler sur ses données).
create table if not exists public.challenge_members (
  challenge_id uuid not null references public.challenges (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         text not null default 'evaluator'
               check (role in ('owner', 'evaluator')),
  created_at   timestamptz not null default now(),
  primary key (challenge_id, user_id)
);

-- « Mes challenges » et suppression d'un compte : recherche par user_id.
create index if not exists challenge_members_user_id_idx
  on public.challenge_members (user_id);

-- Lot d'import : trace de chaque import (fichier, compteurs, synthèse).
-- report : synthèse de l'analyse, SANS données personnelles (contrat du front).
create table if not exists public.import_batches (
  id            uuid primary key default gen_random_uuid(),
  challenge_id  uuid not null references public.challenges (id) on delete cascade,
  file_name     text not null check (char_length(file_name) between 1 and 255),
  imported_by   uuid not null default auth.uid()
                references auth.users (id) on delete restrict,
  imported_at   timestamptz not null default now(),
  rows_read     integer not null default 0 check (rows_read >= 0),
  rows_imported integer not null default 0 check (rows_imported >= 0),
  rows_rejected integer not null default 0 check (rows_rejected >= 0),
  rows_empty    integer not null default 0 check (rows_empty >= 0),
  report        jsonb not null default '{}'::jsonb
                check (jsonb_typeof(report) = 'object'),
  -- Cible des clés étrangères composites (anti-références croisées).
  constraint import_batches_challenge_id_id_key unique (challenge_id, id)
);

create index if not exists import_batches_imported_by_idx
  on public.import_batches (imported_by);

-- Idées importées. (challenge_id, external_ref) unique = import idempotent.
create table if not exists public.ideas (
  id                uuid primary key default gen_random_uuid(),
  challenge_id      uuid not null references public.challenges (id) on delete cascade,
  import_batch_id   uuid,
  external_ref      text not null check (char_length(external_ref) between 1 and 64),
  title             text not null check (char_length(title) between 1 and 300),
  description       text not null check (char_length(description) between 1 and 10000),
  expected_benefits text check (char_length(expected_benefits) <= 5000),
  direction         text check (char_length(direction) <= 120),
  site              text check (char_length(site) <= 120),
  theme             text check (char_length(theme) <= 120),
  budget_raw        text check (char_length(budget_raw) <= 200),
  budget_eur        numeric(12, 2) check (budget_eur >= 0),
  submitted_at      date,
  submitted_at_raw  text check (char_length(submitted_at_raw) <= 100),
  content_hash      text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  quality_flags     text[] not null default '{}'
                    check (cardinality(quality_flags) <= 50),
  raw               jsonb not null default '{}'::jsonb
                    check (jsonb_typeof(raw) = 'object'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint ideas_challenge_id_external_ref_key unique (challenge_id, external_ref),
  -- Cible des clés étrangères composites (auteurs, paires de doublons).
  constraint ideas_challenge_id_id_key unique (challenge_id, id),
  -- Le lot doit appartenir au même challenge que l'idée. À la suppression du
  -- lot, seul import_batch_id passe à NULL (PG 15+), jamais challenge_id.
  constraint ideas_import_batch_fkey
    foreign key (challenge_id, import_batch_id)
    references public.import_batches (challenge_id, id)
    on delete set null (import_batch_id)
);

-- Filtre par challenge : couvert par l'index unique (challenge_id, external_ref).
-- Index de la FK vers le lot (« idées du dernier import », suppression d'un lot).
create index if not exists ideas_challenge_id_import_batch_id_idx
  on public.ideas (challenge_id, import_batch_id);

-- Données personnelles des auteurs, isolées de l'idée.
-- challenge_id ajouté (hors spécification initiale) : la RLS filtre sans
-- jointure et la FK composite garantit que l'auteur suit bien son idée.
create table if not exists public.idea_authors (
  idea_id      uuid primary key,
  challenge_id uuid not null,
  first_name   text check (char_length(first_name) <= 100),
  last_name    text check (char_length(last_name) <= 100),
  email        text check (char_length(email) <= 254),
  constraint idea_authors_idea_fkey
    foreign key (challenge_id, idea_id)
    references public.ideas (challenge_id, id)
    on delete cascade
);

create index if not exists idea_authors_challenge_id_idx
  on public.idea_authors (challenge_id);

-- Paires de doublons candidates. Décision humaine uniquement.
-- Appartenance au même challenge garantie par FK composites (et non par
-- trigger) : déclaratif, impossible à contourner, sans course entre
-- transactions concurrentes.
create table if not exists public.duplicate_pairs (
  id           uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges (id) on delete cascade,
  idea_a       uuid not null,
  idea_b       uuid not null,
  kind         text not null check (kind in ('exact', 'similar')),
  similarity   numeric(4, 3) not null check (similarity between 0 and 1),
  status       text not null default 'suggested'
               check (status in ('suggested', 'confirmed', 'dismissed')),
  decided_by   uuid references auth.users (id) on delete set null,
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  constraint duplicate_pairs_order_check check (idea_a < idea_b),
  constraint duplicate_pairs_idea_a_idea_b_key unique (idea_a, idea_b),
  -- Une décision (confirmée/écartée) est toujours datée ; une suggestion ne
  -- l'est jamais. decided_by peut devenir NULL si le compte est supprimé.
  constraint duplicate_pairs_decision_check check (
    (status = 'suggested' and decided_at is null and decided_by is null)
    or (status <> 'suggested' and decided_at is not null)
  ),
  constraint duplicate_pairs_idea_a_fkey
    foreign key (challenge_id, idea_a)
    references public.ideas (challenge_id, id) on delete cascade,
  constraint duplicate_pairs_idea_b_fkey
    foreign key (challenge_id, idea_b)
    references public.ideas (challenge_id, id) on delete cascade
);

-- Liste des paires d'un challenge filtrée par statut ; idea_a est couvert par
-- l'index unique (idea_a, idea_b), idea_b a besoin du sien (cascade).
create index if not exists duplicate_pairs_challenge_id_status_idx
  on public.duplicate_pairs (challenge_id, status);
create index if not exists duplicate_pairs_idea_b_idx
  on public.duplicate_pairs (idea_b);
create index if not exists duplicate_pairs_decided_by_idx
  on public.duplicate_pairs (decided_by) where decided_by is not null;

-- -----------------------------------------------------------------------------
-- 3. Fonctions d'appartenance (SECURITY DEFINER pour éviter la récursion RLS :
--    elles lisent challenge_members sans repasser par ses politiques).
--    search_path vide, noms entièrement qualifiés.
-- -----------------------------------------------------------------------------

create or replace function public.is_challenge_member(p_challenge_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.challenge_members m
    where m.challenge_id = p_challenge_id
      and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_challenge_owner(p_challenge_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.challenge_members m
    where m.challenge_id = p_challenge_id
      and m.user_id = (select auth.uid())
      and m.role = 'owner'
  );
$$;

-- Le créateur d'un challenge en devient automatiquement « owner ».
-- SECURITY DEFINER : l'ajout doit passer alors que la politique d'INSERT de
-- challenge_members exige déjà d'être owner (œuf et poule).
create or replace function public.add_challenge_creator_as_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.challenge_members (challenge_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict (challenge_id, user_id) do update set role = 'owner';
  return null;
end;
$$;

-- Horodate et signe une décision sur une paire de doublons : le client ne peut
-- ni antidater ni attribuer la décision à quelqu'un d'autre.
create or replace function public.stamp_duplicate_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'suggested' then
      new.decided_by := null;
      new.decided_at := null;
    else
      new.decided_by := (select auth.uid());
      new.decided_at := now();
    end if;
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Triggers
-- -----------------------------------------------------------------------------

drop trigger if exists challenges_set_updated_at on public.challenges;
create trigger challenges_set_updated_at
  before update on public.challenges
  for each row execute function public.set_updated_at();

drop trigger if exists ideas_set_updated_at on public.ideas;
create trigger ideas_set_updated_at
  before update on public.ideas
  for each row execute function public.set_updated_at();

drop trigger if exists challenges_add_creator_as_owner on public.challenges;
create trigger challenges_add_creator_as_owner
  after insert on public.challenges
  for each row execute function public.add_challenge_creator_as_owner();

drop trigger if exists duplicate_pairs_stamp_decision on public.duplicate_pairs;
create trigger duplicate_pairs_stamp_decision
  before update on public.duplicate_pairs
  for each row execute function public.stamp_duplicate_decision();

-- -----------------------------------------------------------------------------
-- 5. Privilèges
--    Supabase accorde par défaut ALL à anon et authenticated sur les nouvelles
--    tables et EXECUTE à PUBLIC sur les fonctions : on repart de zéro et on
--    accorde le strict nécessaire. Les droits UPDATE/INSERT sont limités par
--    colonne : id, challenge_id, created_by, horodatages ne sont pas modifiables
--    par le client.
-- -----------------------------------------------------------------------------

revoke all on table
  public.challenges, public.challenge_members, public.import_batches,
  public.ideas, public.idea_authors, public.duplicate_pairs
from anon, authenticated, public;

grant select, delete on public.challenges to authenticated;
grant insert (title, client_name, jury_date, shortlist_size, created_by)
  on public.challenges to authenticated;
grant update (title, client_name, jury_date, shortlist_size)
  on public.challenges to authenticated;

grant select, delete on public.challenge_members to authenticated;
grant insert (challenge_id, user_id, role) on public.challenge_members to authenticated;
grant update (role) on public.challenge_members to authenticated;

grant select on public.import_batches to authenticated;
grant insert (challenge_id, file_name, imported_by, rows_read, rows_imported,
              rows_rejected, rows_empty, report)
  on public.import_batches to authenticated;

grant select on public.ideas to authenticated;
grant insert (challenge_id, import_batch_id, external_ref, title, description,
              expected_benefits, direction, site, theme, budget_raw, budget_eur,
              submitted_at, submitted_at_raw, content_hash, quality_flags, raw)
  on public.ideas to authenticated;
grant update (import_batch_id, title, description, expected_benefits, direction,
              site, theme, budget_raw, budget_eur, submitted_at, submitted_at_raw,
              content_hash, quality_flags, raw)
  on public.ideas to authenticated;

grant select on public.idea_authors to authenticated;
grant insert (idea_id, challenge_id, first_name, last_name, email)
  on public.idea_authors to authenticated;
grant update (first_name, last_name, email) on public.idea_authors to authenticated;

grant select on public.duplicate_pairs to authenticated;
grant insert (challenge_id, idea_a, idea_b, kind, similarity)
  on public.duplicate_pairs to authenticated;
grant update (status) on public.duplicate_pairs to authenticated;

-- Fonctions de trigger : jamais appelables directement.
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.add_challenge_creator_as_owner() from public, anon, authenticated;
revoke all on function public.stamp_duplicate_decision() from public, anon, authenticated;

-- Fonctions d'appartenance : appelées par les politiques sous le rôle de
-- l'utilisateur, donc exécutables par authenticated (elles ne révèlent que
-- l'appartenance de l'appelant lui-même).
revoke all on function public.is_challenge_member(uuid) from public, anon;
revoke all on function public.is_challenge_owner(uuid) from public, anon;
grant execute on function public.is_challenge_member(uuid) to authenticated;
grant execute on function public.is_challenge_owner(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Row Level Security
--    Pas de FORCE ROW LEVEL SECURITY : l'application se connecte en
--    authenticated (non propriétaire, sans BYPASSRLS), et les fonctions
--    SECURITY DEFINER ci-dessus s'appuient sur le fait que le propriétaire des
--    tables n'est pas soumis à la RLS.
--    Pas de politique DELETE = suppression refusée (sauf cascade depuis le
--    challenge, réservée à son owner).
-- -----------------------------------------------------------------------------

alter table public.challenges        enable row level security;
alter table public.challenge_members enable row level security;
alter table public.import_batches    enable row level security;
alter table public.ideas             enable row level security;
alter table public.idea_authors      enable row level security;
alter table public.duplicate_pairs   enable row level security;

-- challenges ----------------------------------------------------------------
-- « or created_by = auth.uid() » : l'appartenance est créée par un trigger
-- AFTER INSERT, qui s'exécute après la vérification du RETURNING d'un
-- insert().select() ; sans cette clause, le créateur ne pourrait pas relire
-- le challenge qu'il vient de créer.
drop policy if exists challenges_select on public.challenges;
create policy challenges_select on public.challenges
  for select to authenticated
  using (public.is_challenge_member(id) or created_by = (select auth.uid()));

drop policy if exists challenges_insert on public.challenges;
create policy challenges_insert on public.challenges
  for insert to authenticated
  with check (created_by = (select auth.uid()));

drop policy if exists challenges_update on public.challenges;
create policy challenges_update on public.challenges
  for update to authenticated
  using (public.is_challenge_member(id))
  with check (public.is_challenge_member(id));

drop policy if exists challenges_delete on public.challenges;
create policy challenges_delete on public.challenges
  for delete to authenticated
  using (public.is_challenge_owner(id));

-- challenge_members ---------------------------------------------------------
drop policy if exists challenge_members_select on public.challenge_members;
create policy challenge_members_select on public.challenge_members
  for select to authenticated
  using (public.is_challenge_member(challenge_id));

-- Ajout réservé à l'owner : impossible de s'ajouter soi-même au challenge
-- d'autrui.
drop policy if exists challenge_members_insert on public.challenge_members;
create policy challenge_members_insert on public.challenge_members
  for insert to authenticated
  with check (public.is_challenge_owner(challenge_id));

drop policy if exists challenge_members_update on public.challenge_members;
create policy challenge_members_update on public.challenge_members
  for update to authenticated
  using (public.is_challenge_owner(challenge_id))
  with check (public.is_challenge_owner(challenge_id));

drop policy if exists challenge_members_delete on public.challenge_members;
create policy challenge_members_delete on public.challenge_members
  for delete to authenticated
  using (public.is_challenge_owner(challenge_id));

-- import_batches (historique : ni modification ni suppression directe) ------
drop policy if exists import_batches_select on public.import_batches;
create policy import_batches_select on public.import_batches
  for select to authenticated
  using (public.is_challenge_member(challenge_id));

drop policy if exists import_batches_insert on public.import_batches;
create policy import_batches_insert on public.import_batches
  for insert to authenticated
  with check (
    public.is_challenge_member(challenge_id)
    and imported_by = (select auth.uid())
  );

-- ideas -----------------------------------------------------------------------
drop policy if exists ideas_select on public.ideas;
create policy ideas_select on public.ideas
  for select to authenticated
  using (public.is_challenge_member(challenge_id));

drop policy if exists ideas_insert on public.ideas;
create policy ideas_insert on public.ideas
  for insert to authenticated
  with check (public.is_challenge_member(challenge_id));

drop policy if exists ideas_update on public.ideas;
create policy ideas_update on public.ideas
  for update to authenticated
  using (public.is_challenge_member(challenge_id))
  with check (public.is_challenge_member(challenge_id));

-- idea_authors ----------------------------------------------------------------
drop policy if exists idea_authors_select on public.idea_authors;
create policy idea_authors_select on public.idea_authors
  for select to authenticated
  using (public.is_challenge_member(challenge_id));

drop policy if exists idea_authors_insert on public.idea_authors;
create policy idea_authors_insert on public.idea_authors
  for insert to authenticated
  with check (public.is_challenge_member(challenge_id));

drop policy if exists idea_authors_update on public.idea_authors;
create policy idea_authors_update on public.idea_authors
  for update to authenticated
  using (public.is_challenge_member(challenge_id))
  with check (public.is_challenge_member(challenge_id));

-- duplicate_pairs -------------------------------------------------------------
drop policy if exists duplicate_pairs_select on public.duplicate_pairs;
create policy duplicate_pairs_select on public.duplicate_pairs
  for select to authenticated
  using (public.is_challenge_member(challenge_id));

drop policy if exists duplicate_pairs_insert on public.duplicate_pairs;
create policy duplicate_pairs_insert on public.duplicate_pairs
  for insert to authenticated
  with check (public.is_challenge_member(challenge_id));

drop policy if exists duplicate_pairs_update on public.duplicate_pairs;
create policy duplicate_pairs_update on public.duplicate_pairs
  for update to authenticated
  using (public.is_challenge_member(challenge_id))
  with check (public.is_challenge_member(challenge_id));

-- -----------------------------------------------------------------------------
-- 7. RPC d'import atomique
--    SECURITY INVOKER : toutes les écritures passent par la RLS de l'appelant.
--    Une fonction s'exécute dans la transaction de l'appel : toute erreur
--    annule l'import entier (lot, idées, auteurs, paires).
--
--    Codes d'erreur :
--      42501  l'appelant n'est pas membre du challenge
--      22023  paramètre invalide (tailles, format, références en double ou
--             introuvables, paire d'une idée avec elle-même)
--      23514 / 23502 / 22P02 / 22007  valeur refusée par une contrainte ou un
--             type (titre trop long, hash invalide, date illisible…)
-- -----------------------------------------------------------------------------

create or replace function public.import_ideas(
  p_challenge_id uuid,
  p_file_name    text,
  p_ideas        jsonb,
  p_duplicates   jsonb,
  p_report       jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_duplicates jsonb := coalesce(p_duplicates, '[]'::jsonb);
  v_report     jsonb := coalesce(p_report, '{}'::jsonb);
  v_batch_id   uuid;
  v_inserted   integer;
  v_updated    integer;
  v_pairs_in   integer;
  v_pairs_ok   integer;
  v_dups_added integer;
begin
  -- 1. Autorisation (avant toute lecture du contenu).
  if p_challenge_id is null or not public.is_challenge_member(p_challenge_id) then
    raise exception 'import_ideas : accès refusé à ce challenge'
      using errcode = '42501';
  end if;

  -- 2. Bornes et formes des paramètres.
  if p_ideas is null or jsonb_typeof(p_ideas) <> 'array'
     or jsonb_array_length(p_ideas) not between 1 and 2000 then
    raise exception 'import_ideas : p_ideas doit être un tableau de 1 à 2000 idées'
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_duplicates) <> 'array'
     or jsonb_array_length(v_duplicates) > 5000 then
    raise exception 'import_ideas : p_duplicates doit être un tableau d''au plus 5000 paires'
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_report) <> 'object' then
    raise exception 'import_ideas : p_report doit être un objet'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_ideas) e where jsonb_typeof(e) <> 'object'
  ) then
    raise exception 'import_ideas : chaque idée doit être un objet'
      using errcode = '22023';
  end if;

  -- Deux lignes du même lot avec la même référence : l'upsert ne peut pas
  -- trancher, on refuse explicitement.
  if exists (
    select 1
    from jsonb_array_elements(p_ideas) e
    group by e ->> 'external_ref'
    having count(*) > 1
  ) then
    raise exception 'import_ideas : référence d''idée en double dans le lot'
      using errcode = '22023';
  end if;

  -- 3. Lot d'import.
  insert into public.import_batches (
    challenge_id, file_name, imported_by,
    rows_read, rows_imported, rows_rejected, rows_empty, report
  )
  values (
    p_challenge_id, p_file_name, (select auth.uid()),
    coalesce((v_report ->> 'rows_read')::integer, 0),
    coalesce((v_report ->> 'rows_imported')::integer, 0),
    coalesce((v_report ->> 'rows_rejected')::integer, 0),
    coalesce((v_report ->> 'rows_empty')::integer, 0),
    v_report
  )
  returning id into v_batch_id;

  -- 4. Idées : insert ou mise à jour sur (challenge_id, external_ref).
  --    xmax = 0 sur la ligne retournée <=> la ligne vient d'être insérée.
  with upserted as (
    insert into public.ideas as i (
      challenge_id, import_batch_id, external_ref, title, description,
      expected_benefits, direction, site, theme, budget_raw, budget_eur,
      submitted_at, submitted_at_raw, content_hash, quality_flags, raw
    )
    select
      p_challenge_id,
      v_batch_id,
      e ->> 'external_ref',
      e ->> 'title',
      e ->> 'description',
      e ->> 'expected_benefits',
      e ->> 'direction',
      e ->> 'site',
      e ->> 'theme',
      e ->> 'budget_raw',
      (e ->> 'budget_eur')::numeric,
      (e ->> 'submitted_at')::date,
      e ->> 'submitted_at_raw',
      e ->> 'content_hash',
      case
        when jsonb_typeof(e -> 'quality_flags') = 'array'
          then array(select jsonb_array_elements_text(e -> 'quality_flags'))
        else '{}'::text[]
      end,
      case
        when jsonb_typeof(e -> 'raw') = 'object' then e -> 'raw'
        else '{}'::jsonb
      end
    from jsonb_array_elements(p_ideas) as e
    on conflict (challenge_id, external_ref) do update set
      import_batch_id   = excluded.import_batch_id,
      title             = excluded.title,
      description       = excluded.description,
      expected_benefits = excluded.expected_benefits,
      direction         = excluded.direction,
      site              = excluded.site,
      theme             = excluded.theme,
      budget_raw        = excluded.budget_raw,
      budget_eur        = excluded.budget_eur,
      submitted_at      = excluded.submitted_at,
      submitted_at_raw  = excluded.submitted_at_raw,
      content_hash      = excluded.content_hash,
      quality_flags     = excluded.quality_flags,
      raw               = excluded.raw
    returning (i.xmax = 0) as was_inserted
  )
  select
    count(*) filter (where was_inserted),
    count(*) filter (where not was_inserted)
  into v_inserted, v_updated
  from upserted;

  -- 5. Auteurs : insert ou mise à jour. Un auteur absent (null) dans ce lot ne
  --    supprime pas l'auteur déjà connu.
  insert into public.idea_authors (idea_id, challenge_id, first_name, last_name, email)
  select
    i.id,
    i.challenge_id,
    nullif(btrim(e -> 'author' ->> 'first_name'), ''),
    nullif(btrim(e -> 'author' ->> 'last_name'), ''),
    nullif(btrim(e -> 'author' ->> 'email'), '')
  from jsonb_array_elements(p_ideas) as e
  join public.ideas as i
    on i.challenge_id = p_challenge_id
   and i.external_ref = e ->> 'external_ref'
  where jsonb_typeof(e -> 'author') = 'object'
    and coalesce(
          nullif(btrim(e -> 'author' ->> 'first_name'), ''),
          nullif(btrim(e -> 'author' ->> 'last_name'), ''),
          nullif(btrim(e -> 'author' ->> 'email'), '')
        ) is not null
  on conflict (idea_id) do update set
    first_name = excluded.first_name,
    last_name  = excluded.last_name,
    email      = excluded.email;

  -- 6. Paires de doublons : références résolues dans CE lot uniquement,
  --    ordonnées (idea_a < idea_b). on conflict do nothing : une décision
  --    humaine existante n'est jamais écrasée.
  v_pairs_in := jsonb_array_length(v_duplicates);

  if v_pairs_in > 0 then
    if exists (
      select 1 from jsonb_array_elements(v_duplicates) d
      where jsonb_typeof(d) <> 'object'
         or d ->> 'ref_a' is null
         or d ->> 'ref_b' is null
         or d ->> 'ref_a' = d ->> 'ref_b'
    ) then
      raise exception 'import_ideas : paire de doublons invalide (références manquantes ou identiques)'
        using errcode = '22023';
    end if;

    -- Une seule instruction : résolution des références, insertion, comptages.
    -- Si une référence est introuvable, l'exception levée juste après annule
    -- aussi l'insertion (tout l'appel est une seule transaction).
    with resolved as (
      select
        least(a.id, b.id)            as idea_a,
        greatest(a.id, b.id)         as idea_b,
        d ->> 'kind'                 as kind,
        (d ->> 'similarity')::numeric as similarity
      from jsonb_array_elements(v_duplicates) as d
      join public.ideas as a
        on a.challenge_id = p_challenge_id
       and a.import_batch_id = v_batch_id
       and a.external_ref = d ->> 'ref_a'
      join public.ideas as b
        on b.challenge_id = p_challenge_id
       and b.import_batch_id = v_batch_id
       and b.external_ref = d ->> 'ref_b'
    ),
    added as (
      insert into public.duplicate_pairs (challenge_id, idea_a, idea_b, kind, similarity)
      select distinct on (r.idea_a, r.idea_b)
        p_challenge_id, r.idea_a, r.idea_b, r.kind, r.similarity
      from resolved as r
      order by r.idea_a, r.idea_b, r.similarity desc
      on conflict (idea_a, idea_b) do nothing
      returning 1
    )
    select (select count(*) from resolved), (select count(*) from added)
    into v_pairs_ok, v_dups_added;

    if v_pairs_ok <> v_pairs_in then
      raise exception 'import_ideas : une paire de doublons référence une idée absente du lot'
        using errcode = '22023';
    end if;
  else
    v_dups_added := 0;
  end if;

  return jsonb_build_object(
    'batch_id',         v_batch_id,
    'inserted',         v_inserted,
    'updated',          v_updated,
    'duplicates_added', v_dups_added
  );
end;
$$;

revoke all on function public.import_ideas(uuid, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.import_ideas(uuid, text, jsonb, jsonb, jsonb) to authenticated;

reset lock_timeout;
