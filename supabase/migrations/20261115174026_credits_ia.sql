-- =============================================================================
-- Migration : crédits IA par utilisateur et journal de consommation
--             (ADR 0003, §3 et §7 « M-B », avec les décisions de l'utilisateur
--             du 2026-11-15 : crédit MENSUEL, réservation puis régularisation)
-- -----------------------------------------------------------------------------
-- Ajoute :
--   * ai_credit_accounts : un compte par utilisateur, avec une allocation
--     mensuelle facultative propre à l'utilisateur (NULL = allocation par
--     défaut, 5 000 000 µ€ = 5 €) ;
--   * ai_credit_months : le solde d'un utilisateur pour un mois calendaire
--     (allocation figée à l'ouverture du mois, recrédits de l'opérateur,
--     consommation régularisée). C'est le POINT DE VERROUILLAGE qui sérialise
--     les réservations concurrentes d'un même utilisateur (select … for
--     update). Le 1er du mois, une nouvelle ligne repart à l'allocation ;
--     les mois passés restent (historique) ;
--   * ai_credit_reservations : réservation pessimiste prise AVANT une
--     évaluation ou un message de discussion, puis régularisée au coût réel
--     (le reliquat est rendu), libérée, ou expirée ;
--   * ai_credit_ledger : journal IMMUABLE (audit). Une ligne « usage » par
--     appel IA réellement facturé, une ligne « grant » par recrédit de
--     l'opérateur. Aucune donnée personnelle ni contenu d'idée ;
--   * des fonctions SECURITY DEFINER exécutables par service_role SEULEMENT
--     (réserver, régulariser, libérer, expirer, recréditer, fixer
--     l'allocation), et my_ai_credit() pour que l'utilisateur lise SON solde.
--
-- Unité : micro-euros entiers (bigint), jamais de flottant.
--
-- Mois calendaire : calculé dans le fuseau Europe/Paris (le crédit « repart
-- le 1er du mois » à minuit, heure française). Une réservation est rattachée
-- au mois où elle est prise ; sa régularisation est imputée à CE mois, même
-- si elle a lieu après minuit le 1er (rien n'est compté deux fois).
--
-- Solde du mois :
--   restant = allocation + recrédits − consommé − réservé en cours
--   « réservé en cours » = somme des réservations actives NON échues : une
--   réservation échue (expires_at ≤ maintenant) ne compte plus, même avant
--   que expire_ai_credit_reservations() ne l'ait marquée « expired ». Le
--   solde ne peut donc pas rester bloqué par un serveur tombé.
--   La régularisation enregistre le coût RÉEL, même s'il dépasse la
--   réservation (relance de format, résultats web plus longs) : le restant
--   peut alors devenir légèrement négatif, borné par une opération (ADR 0003
--   §3.3). La réservation empêche de DÉMARRER sans fonds ; elle ne ment pas
--   sur le coût.
--
-- Références au challenge, à l'idée et à l'évaluation : SOUPLES (uuid sans
-- clé étrangère) dans le journal et les réservations. Arbitrage :
--   * le journal d'audit doit survivre à la suppression d'un challenge (le
--     crédit consommé a été payé au fournisseur) ;
--   * une FK « on delete set null » serait une MISE À JOUR du journal, que
--     l'on veut immuable (déclencheur), et effacerait le détail par
--     évaluation qui sert justement à l'audit ;
--   * la cohérence est vérifiée À L'ÉCRITURE par reserve_ai_credit :
--     l'utilisateur est membre du challenge, l'idée appartient au challenge,
--     l'évaluation à l'idée. Après suppression du challenge, les uuid restent
--     (ils ne contiennent rien de personnel) et ne pointent plus sur rien.
-- Les utilisateurs, eux, sont référencés par de vraies FK « on delete
-- restrict » (comme evaluations.requested_by) : historique de coût.
--
-- Écritures : uniquement par les fonctions ci-dessous. Ni authenticated ni
-- service_role n'ont de privilège d'écriture sur les tables ; le journal
-- refuse en plus toute modification ou suppression par déclencheur (même
-- pour le propriétaire). RLS activée sans FORCE (mêmes choix que les
-- migrations précédentes) : authenticated ne lit que ses propres lignes.
--
-- Codes d'erreur (SQLSTATE ; le message est le code applicatif) :
--   CI001  credit_ia_epuise              solde du mois insuffisant pour la
--                                        réservation demandée (HTTP 402 côté
--                                        serveur ; DETAIL : disponible et
--                                        demandé, en µ€)
--   CI002  reservation_ia_introuvable    réservation inconnue
--   CI003  reservation_ia_deja_cloturee  réservation déjà régularisée ou
--                                        libérée (ou rejouée alors qu'elle
--                                        est close ou échue)
--   42501  l'utilisateur n'est pas membre du challenge ; ou tentative de
--          modifier le journal
--   22023  paramètre invalide (montant négatif ou nul, type d'opération,
--          clé, durée, idée/évaluation hors du challenge, événements mal
--          formés ou dont la somme diffère du coût réel)
--   23503  utilisateur inexistant (FK vers auth.users)
--
-- Idempotence : « if not exists », « create or replace », « drop ... if
-- exists » : rejouable sans effet de bord.
-- =============================================================================

-- Verrous courts (FK vers auth.users) : on abandonne plutôt que de bloquer la
-- file d'attente. Toutes les tables sont nouvelles.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------

-- Compte de crédit d'un utilisateur, créé à sa première réservation (ou au
-- premier geste de l'opérateur).
-- monthly_allocation_micro_eur : allocation mensuelle propre à l'utilisateur ;
-- NULL = allocation par défaut (ai_credit_default_allocation()). Modifiable
-- seulement par l'opérateur (set_ai_credit_allocation, service_role).
create table if not exists public.ai_credit_accounts (
  user_id                      uuid primary key
                               references auth.users (id) on delete restrict,
  monthly_allocation_micro_eur bigint check (monthly_allocation_micro_eur >= 0),
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

-- Solde d'un utilisateur pour un mois calendaire (month = 1er jour du mois,
-- fuseau Europe/Paris).
-- allocation_micro_eur : allocation figée à l'ouverture du mois (l'historique
-- garde l'allocation de l'époque) ; set_ai_credit_allocation la met à jour
-- pour le mois en cours.
-- granted_micro_eur : recrédits de l'opérateur pour ce mois (= somme des
-- lignes « grant » du journal pour ce mois).
-- consumed_micro_eur : coût réel régularisé (= somme des lignes « usage » du
-- journal pour ce mois).
create table if not exists public.ai_credit_months (
  user_id            uuid not null
                     references public.ai_credit_accounts (user_id) on delete restrict,
  month              date not null,
  allocation_micro_eur bigint not null check (allocation_micro_eur >= 0),
  granted_micro_eur  bigint not null default 0 check (granted_micro_eur >= 0),
  consumed_micro_eur bigint not null default 0 check (consumed_micro_eur >= 0),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (user_id, month),
  constraint ai_credit_months_first_day_check
    check (extract(day from month) = 1)
);

-- Réservation de crédit avant une opération IA.
-- kind : 'evaluation' (une évaluation complète, tous agents) ou 'discussion'
-- (un message sur la fiche d'une idée).
-- idempotency_key : unique par utilisateur (« eval:<id>:<tentative> »,
-- « chat:<id client du message> ») ; une requête rejouée ne réserve pas deux
-- fois.
-- challenge_id, idea_id, evaluation_id : références souples (cf. en-tête).
-- consumed_micro_eur : coût réel, renseigné à la régularisation seulement.
create table if not exists public.ai_credit_reservations (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null,
  month              date not null,
  kind               text not null check (kind in ('evaluation', 'discussion')),
  idempotency_key    text not null
                     check (char_length(idempotency_key) between 1 and 120),
  challenge_id       uuid not null,
  idea_id            uuid,
  evaluation_id      uuid,
  amount_micro_eur   bigint not null check (amount_micro_eur > 0),
  consumed_micro_eur bigint check (consumed_micro_eur >= 0),
  status             text not null default 'active'
                     check (status in ('active', 'settled', 'released', 'expired')),
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now(),
  closed_at          timestamptz,
  constraint ai_credit_reservations_month_fkey
    foreign key (user_id, month)
    references public.ai_credit_months (user_id, month) on delete restrict,
  constraint ai_credit_reservations_user_id_idempotency_key_key
    unique (user_id, idempotency_key),
  -- Une réservation close a toujours sa date de clôture, et seulement elle.
  constraint ai_credit_reservations_closed_status_check
    check ((status = 'active') = (closed_at is null)),
  -- Le coût réel n'existe que pour une réservation régularisée.
  constraint ai_credit_reservations_settled_cost_check
    check ((status = 'settled') = (consumed_micro_eur is not null)),
  constraint ai_credit_reservations_expiry_after_creation_check
    check (expires_at > created_at)
);

-- Réservé en cours et nombre d'opérations du mois d'un utilisateur ; sert
-- aussi la FK (user_id, month).
create index if not exists ai_credit_reservations_user_id_month_status_idx
  on public.ai_credit_reservations (user_id, month, status);
-- Nettoyage des réservations échues (expire_ai_credit_reservations).
create index if not exists ai_credit_reservations_active_expires_at_idx
  on public.ai_credit_reservations (expires_at)
  where status = 'active';

-- Journal immuable.
-- kind 'usage' : un appel IA réellement facturé (rattaché à une réservation,
-- avec agent, modèle et jetons) ; kind 'grant' : un recrédit de l'opérateur
-- (avec sa raison). amount_micro_eur est toujours positif ou nul, le sens
-- est donné par kind.
-- month : mois d'imputation (celui de la réservation pour un usage).
-- agent : rôle de l'agent (analyste, consultant, associe, economique,
-- assistant…), format contrôlé plutôt que liste fermée.
-- estimated : coût pessimiste enregistré faute de consommation réelle
-- connue (délai dépassé côté fournisseur, ADR 0003 §3.3).
create table if not exists public.ai_credit_ledger (
  id               bigint generated always as identity primary key,
  user_id          uuid not null,
  month            date not null,
  kind             text not null check (kind in ('usage', 'grant')),
  amount_micro_eur bigint not null check (amount_micro_eur >= 0),
  reservation_id   uuid references public.ai_credit_reservations (id) on delete restrict,
  operation        text check (operation in ('evaluation', 'discussion')),
  challenge_id     uuid,
  idea_id          uuid,
  evaluation_id    uuid,
  agent            text check (agent ~ '^[a-z_]{2,40}$'),
  model            text check (char_length(model) between 1 and 120),
  input_tokens     integer check (input_tokens >= 0),
  output_tokens    integer check (output_tokens >= 0),
  cached_tokens    integer check (cached_tokens >= 0),
  web_searches     integer check (web_searches >= 0),
  estimated        boolean not null default false,
  reason           text check (char_length(reason) between 1 and 300),
  created_at       timestamptz not null default now(),
  constraint ai_credit_ledger_month_fkey
    foreign key (user_id, month)
    references public.ai_credit_months (user_id, month) on delete restrict,
  -- Un appel IA porte sa réservation, son opération, son challenge, son
  -- agent, son modèle et ses jetons ; pas de raison.
  constraint ai_credit_ledger_usage_shape_check check (
    kind <> 'usage' or (
      reservation_id is not null and operation is not null
      and challenge_id is not null and agent is not null and model is not null
      and input_tokens is not null and output_tokens is not null
      and cached_tokens is not null and web_searches is not null
      and reason is null
    )
  ),
  -- Un recrédit est strictement positif, porte une raison et rien d'un appel.
  constraint ai_credit_ledger_grant_shape_check check (
    kind <> 'grant' or (
      amount_micro_eur > 0 and reason is not null
      and reservation_id is null and operation is null and challenge_id is null
      and idea_id is null and evaluation_id is null and agent is null
      and model is null and input_tokens is null and output_tokens is null
      and cached_tokens is null and web_searches is null and not estimated
    )
  )
);

-- Détail du mois d'un utilisateur (le plus récent d'abord) ; sert aussi la
-- FK (user_id, month).
create index if not exists ai_credit_ledger_user_id_month_created_at_idx
  on public.ai_credit_ledger (user_id, month, created_at desc);
-- Appels d'une réservation ; sert aussi la FK reservation_id.
create index if not exists ai_credit_ledger_reservation_id_idx
  on public.ai_credit_ledger (reservation_id)
  where reservation_id is not null;
-- Coût d'une évaluation affiché sur la fiche (ADR 0003 §3.5).
create index if not exists ai_credit_ledger_evaluation_id_idx
  on public.ai_credit_ledger (evaluation_id)
  where evaluation_id is not null;

-- -----------------------------------------------------------------------------
-- 2. Journal immuable : refus de toute modification ou suppression, y compris
--    par le propriétaire des tables (les privilèges suffisent pour les
--    clients et service_role ; le déclencheur couvre le reste).
-- -----------------------------------------------------------------------------

create or replace function public.ai_credit_ledger_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'ai_credit_ledger : le journal de consommation est immuable'
    using errcode = '42501';
end;
$$;

drop trigger if exists ai_credit_ledger_no_update_delete on public.ai_credit_ledger;
create trigger ai_credit_ledger_no_update_delete
  before update or delete on public.ai_credit_ledger
  for each row execute function public.ai_credit_ledger_immutable();

drop trigger if exists ai_credit_ledger_no_truncate on public.ai_credit_ledger;
create trigger ai_credit_ledger_no_truncate
  before truncate on public.ai_credit_ledger
  for each statement execute function public.ai_credit_ledger_immutable();

-- -----------------------------------------------------------------------------
-- 3. Fonctions
--    p_now (défaut now()) rend la date injectable : tests du changement de
--    mois et de l'expiration sans dépendre de l'horloge. Le serveur ne le
--    renseigne pas.
--    Ordre des verrous, partout le même : ligne du mois (ai_credit_months),
--    puis réservation. Pas d'interblocage entre réserver, régulariser et
--    libérer.
-- -----------------------------------------------------------------------------

-- Allocation mensuelle par défaut : 5 € = 5 000 000 µ€. La changer = une
-- nouvelle migration (create or replace) ; s'applique aux mois ouverts
-- ensuite.
create or replace function public.ai_credit_default_allocation()
returns bigint
language sql
immutable
set search_path = ''
as $$
  select 5000000::bigint;
$$;

-- Ouvre (si besoin) le compte et le mois de p_now pour p_user_id, puis
-- VERROUILLE la ligne du mois et la renvoie. Interne : appelée par les
-- fonctions SECURITY DEFINER ci-dessous, non exécutable par les clients.
create or replace function public.ai_credit_lock_month(p_user_id uuid, p_now timestamptz)
returns public.ai_credit_months
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_now at time zone 'Europe/Paris')::date;
  v_row   public.ai_credit_months;
begin
  insert into public.ai_credit_accounts (user_id, created_at, updated_at)
  values (p_user_id, p_now, p_now)
  on conflict (user_id) do nothing;

  insert into public.ai_credit_months (user_id, month, allocation_micro_eur, created_at, updated_at)
  select a.user_id, v_month,
         coalesce(a.monthly_allocation_micro_eur, public.ai_credit_default_allocation()),
         p_now, p_now
  from public.ai_credit_accounts a
  where a.user_id = p_user_id
  on conflict (user_id, month) do nothing;

  select m.* into v_row
  from public.ai_credit_months m
  where m.user_id = p_user_id and m.month = v_month
  for update;

  return v_row;
end;
$$;

-- Réserve p_amount_micro_eur sur le mois en cours de p_user_id avant une
-- opération IA. Renvoie l'identifiant de la réservation.
-- * Atomique et sûre en concurrence : la ligne du mois est verrouillée, deux
--   réservations simultanées sont sérialisées et ne peuvent pas dépasser le
--   solde ensemble.
-- * Refus (CI001 credit_ia_epuise) si restant < montant demandé.
-- * Idempotente : même (utilisateur, clé) → même réservation tant qu'elle est
--   active ; rejouée close ou échue → CI003 ; rejouée pour une autre
--   opération ou un autre challenge → 22023.
-- * Expire au passage les réservations échues de l'utilisateur.
-- * Vérifie que l'utilisateur est membre du challenge (42501), que l'idée
--   appartient au challenge et l'évaluation à l'idée (22023).
create or replace function public.reserve_ai_credit(
  p_user_id          uuid,
  p_amount_micro_eur bigint,
  p_kind             text,
  p_idempotency_key  text,
  p_challenge_id     uuid,
  p_idea_id          uuid default null,
  p_evaluation_id    uuid default null,
  p_ttl              interval default interval '30 minutes',
  p_now              timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month     public.ai_credit_months;
  v_existing  public.ai_credit_reservations;
  v_reserved  bigint;
  v_available bigint;
  v_id        uuid;
begin
  -- 1. Paramètres.
  if p_amount_micro_eur is null or p_amount_micro_eur <= 0 then
    raise exception 'reserve_ai_credit : le montant doit être strictement positif'
      using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('evaluation', 'discussion') then
    raise exception 'reserve_ai_credit : type d''opération inconnu'
      using errcode = '22023';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 120 then
    raise exception 'reserve_ai_credit : clé d''idempotence de 1 à 120 caractères requise'
      using errcode = '22023';
  end if;
  if p_ttl is null or p_ttl < interval '1 minute' or p_ttl > interval '1 day' then
    raise exception 'reserve_ai_credit : durée de réservation entre 1 minute et 1 jour'
      using errcode = '22023';
  end if;
  if p_user_id is null or p_challenge_id is null or p_now is null then
    raise exception 'reserve_ai_credit : utilisateur, challenge et date requis'
      using errcode = '22023';
  end if;

  -- 2. Rattachement cohérent (références souples vérifiées à l'écriture).
  if not exists (
    select 1 from public.challenge_members cm
    where cm.challenge_id = p_challenge_id and cm.user_id = p_user_id
  ) then
    raise exception 'reserve_ai_credit : l''utilisateur n''est pas membre du challenge'
      using errcode = '42501';
  end if;
  if p_idea_id is not null and not exists (
    select 1 from public.ideas i
    where i.id = p_idea_id and i.challenge_id = p_challenge_id
  ) then
    raise exception 'reserve_ai_credit : idée introuvable dans ce challenge'
      using errcode = '22023';
  end if;
  if p_evaluation_id is not null and not exists (
    select 1 from public.evaluations e
    where e.id = p_evaluation_id and e.challenge_id = p_challenge_id
      and e.idea_id is not distinct from p_idea_id
  ) then
    raise exception 'reserve_ai_credit : évaluation introuvable pour cette idée'
      using errcode = '22023';
  end if;

  -- 3. Verrou du mois (sérialise les réservations de cet utilisateur).
  v_month := public.ai_credit_lock_month(p_user_id, p_now);

  -- 4. Réservations échues de l'utilisateur : marquées « expired ».
  update public.ai_credit_reservations r
  set status = 'expired', closed_at = p_now
  where r.user_id = p_user_id and r.status = 'active' and r.expires_at <= p_now;

  -- 5. Rejeu de la même demande.
  select r.* into v_existing
  from public.ai_credit_reservations r
  where r.user_id = p_user_id and r.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_existing.kind <> p_kind or v_existing.challenge_id <> p_challenge_id then
      raise exception 'reserve_ai_credit : clé d''idempotence déjà utilisée pour une autre opération'
        using errcode = '22023';
    end if;
    if v_existing.status <> 'active' then
      raise exception 'reservation_ia_deja_cloturee'
        using errcode = 'CI003',
              detail = format('statut=%s', v_existing.status);
    end if;
    return v_existing.id;
  end if;

  -- 6. Solde du mois.
  select coalesce(sum(r.amount_micro_eur), 0) into v_reserved
  from public.ai_credit_reservations r
  where r.user_id = p_user_id and r.month = v_month.month
    and r.status = 'active' and r.expires_at > p_now;

  v_available := v_month.allocation_micro_eur + v_month.granted_micro_eur
                 - v_month.consumed_micro_eur - v_reserved;

  if v_available < p_amount_micro_eur then
    raise exception 'credit_ia_epuise'
      using errcode = 'CI001',
            detail = format('disponible=%s demande=%s', greatest(v_available, 0), p_amount_micro_eur);
  end if;

  -- 7. Réservation.
  insert into public.ai_credit_reservations
    (user_id, month, kind, idempotency_key, challenge_id, idea_id, evaluation_id,
     amount_micro_eur, expires_at, created_at)
  values
    (p_user_id, v_month.month, p_kind, p_idempotency_key, p_challenge_id, p_idea_id,
     p_evaluation_id, p_amount_micro_eur, p_now + p_ttl, p_now)
  returning id into v_id;

  return v_id;
end;
$$;

-- Régularise une réservation au coût réel et rend le reliquat. Renvoie le
-- reliquat libéré (montant réservé − coût réel, 0 si le coût dépasse).
-- p_actual_micro_eur : coût réel total (≥ 0), égal à la somme des coûts des
-- événements.
-- p_events : tableau (100 au plus) d'appels IA réellement facturés, un objet
-- par appel :
--   {"agent": "consultant", "model": "glm-5.2", "input_tokens": 1200,
--    "output_tokens": 300, "cost_micro_eur": 1520,
--    "cached_tokens": 0, "web_searches": 1, "estimated": false}
--   (cached_tokens, web_searches et estimated sont facultatifs). Aucune donnée
--   personnelle ni contenu : les clés inconnues sont ignorées.
-- p_evaluation_id : évaluation créée après la réservation (facultatif ;
--   vérifiée : même challenge et même idée).
-- Une réservation échue peut encore être régularisée (les appels ont été
-- payés) ; une réservation régularisée ou libérée est refusée (CI003) : une
-- double régularisation ne compte jamais deux fois.
create or replace function public.settle_ai_credit(
  p_reservation_id   uuid,
  p_actual_micro_eur bigint,
  p_events           jsonb,
  p_evaluation_id    uuid default null,
  p_now              timestamptz default now()
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res        public.ai_credit_reservations;
  v_evaluation uuid;
  v_sum        numeric;
begin
  -- 1. Paramètres.
  if p_actual_micro_eur is null or p_actual_micro_eur < 0 then
    raise exception 'settle_ai_credit : le coût réel doit être positif ou nul'
      using errcode = '22023';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array'
     or jsonb_array_length(p_events) > 100 then
    raise exception 'settle_ai_credit : p_events doit être un tableau de 100 appels au plus'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_events) e
    where jsonb_typeof(e) <> 'object'
       or jsonb_typeof(e -> 'cost_micro_eur') is distinct from 'number'
       or (e ->> 'cost_micro_eur')::numeric < 0
       or (e ->> 'cost_micro_eur')::numeric <> trunc((e ->> 'cost_micro_eur')::numeric)
  ) then
    raise exception 'settle_ai_credit : chaque appel doit être un objet avec un coût entier positif ou nul'
      using errcode = '22023';
  end if;
  select coalesce(sum((e ->> 'cost_micro_eur')::numeric), 0) into v_sum
  from jsonb_array_elements(p_events) e;
  if v_sum <> p_actual_micro_eur then
    raise exception 'settle_ai_credit : la somme des appels diffère du coût réel'
      using errcode = '22023';
  end if;

  -- 2. Verrous : le mois de la réservation, puis la réservation.
  select r.* into v_res
  from public.ai_credit_reservations r
  where r.id = p_reservation_id;
  if not found then
    raise exception 'reservation_ia_introuvable' using errcode = 'CI002';
  end if;

  perform 1 from public.ai_credit_months m
  where m.user_id = v_res.user_id and m.month = v_res.month
  for update;

  select r.* into v_res
  from public.ai_credit_reservations r
  where r.id = p_reservation_id
  for update;

  if v_res.status not in ('active', 'expired') then
    raise exception 'reservation_ia_deja_cloturee'
      using errcode = 'CI003',
            detail = format('statut=%s', v_res.status);
  end if;

  -- 3. Évaluation rattachée après coup.
  v_evaluation := coalesce(v_res.evaluation_id, p_evaluation_id);
  if p_evaluation_id is not null then
    if v_res.evaluation_id is not null and v_res.evaluation_id <> p_evaluation_id then
      raise exception 'settle_ai_credit : la réservation porte déjà une autre évaluation'
        using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.evaluations e
      where e.id = p_evaluation_id and e.challenge_id = v_res.challenge_id
        and e.idea_id is not distinct from v_res.idea_id
    ) then
      raise exception 'settle_ai_credit : évaluation introuvable pour cette idée'
        using errcode = '22023';
    end if;
  end if;

  -- 4. Journal : un événement par appel facturé, imputé au mois de la
  --    réservation.
  insert into public.ai_credit_ledger
    (user_id, month, kind, amount_micro_eur, reservation_id, operation,
     challenge_id, idea_id, evaluation_id, agent, model,
     input_tokens, output_tokens, cached_tokens, web_searches, estimated, created_at)
  select v_res.user_id, v_res.month, 'usage', x.cost_micro_eur, v_res.id, v_res.kind,
         v_res.challenge_id, v_res.idea_id, v_evaluation, x.agent, x.model,
         x.input_tokens, x.output_tokens, coalesce(x.cached_tokens, 0),
         coalesce(x.web_searches, 0), coalesce(x.estimated, false), p_now
  from jsonb_to_recordset(p_events) as x(
    agent text, model text, input_tokens integer, output_tokens integer,
    cost_micro_eur bigint, cached_tokens integer, web_searches integer, estimated boolean
  );

  -- 5. Solde et réservation.
  update public.ai_credit_months m
  set consumed_micro_eur = m.consumed_micro_eur + p_actual_micro_eur,
      updated_at = p_now
  where m.user_id = v_res.user_id and m.month = v_res.month;

  update public.ai_credit_reservations r
  set status = 'settled', consumed_micro_eur = p_actual_micro_eur,
      evaluation_id = v_evaluation, closed_at = p_now
  where r.id = v_res.id;

  return greatest(v_res.amount_micro_eur - p_actual_micro_eur, 0);
end;
$$;

-- Libère une réservation sans consommation (opération annulée avant tout
-- appel facturé). Renvoie true si elle était active, false si elle était déjà
-- close (sans effet : sûr dans un « finally »). Réservation inconnue → CI002.
create or replace function public.release_ai_credit(
  p_reservation_id uuid,
  p_now            timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res public.ai_credit_reservations;
begin
  select r.* into v_res
  from public.ai_credit_reservations r
  where r.id = p_reservation_id;
  if not found then
    raise exception 'reservation_ia_introuvable' using errcode = 'CI002';
  end if;

  perform 1 from public.ai_credit_months m
  where m.user_id = v_res.user_id and m.month = v_res.month
  for update;

  update public.ai_credit_reservations r
  set status = 'released', closed_at = p_now
  where r.id = p_reservation_id and r.status = 'active';

  return found;
end;
$$;

-- Marque « expired » toutes les réservations actives échues (tâche
-- périodique). Renvoie leur nombre. Facultatif pour le solde (une
-- réservation échue n'est déjà plus comptée), utile pour l'état affiché.
create or replace function public.expire_ai_credit_reservations(
  p_now timestamptz default now()
)
returns integer
language sql
security definer
set search_path = ''
as $$
  with expired as (
    update public.ai_credit_reservations r
    set status = 'expired', closed_at = p_now
    where r.status = 'active' and r.expires_at <= p_now
    returning 1
  )
  select count(*)::integer from expired;
$$;

-- Recrédit par l'opérateur (script local avec la clé secrète) : ajoute
-- p_amount_micro_eur au mois en cours de p_user_id et l'inscrit au journal
-- avec sa raison. Renvoie le restant du mois après recrédit. Le propriétaire
-- d'un challenge ne peut pas recréditer (aucun droit pour authenticated).
create or replace function public.grant_ai_credit(
  p_user_id          uuid,
  p_amount_micro_eur bigint,
  p_reason           text,
  p_now              timestamptz default now()
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month    public.ai_credit_months;
  v_reserved bigint;
begin
  if p_amount_micro_eur is null or p_amount_micro_eur <= 0 then
    raise exception 'grant_ai_credit : le montant doit être strictement positif'
      using errcode = '22023';
  end if;
  if p_reason is null or char_length(p_reason) not between 1 and 300 then
    raise exception 'grant_ai_credit : raison de 1 à 300 caractères requise'
      using errcode = '22023';
  end if;
  if p_user_id is null or p_now is null then
    raise exception 'grant_ai_credit : utilisateur et date requis'
      using errcode = '22023';
  end if;

  v_month := public.ai_credit_lock_month(p_user_id, p_now);

  update public.ai_credit_months m
  set granted_micro_eur = m.granted_micro_eur + p_amount_micro_eur,
      updated_at = p_now
  where m.user_id = p_user_id and m.month = v_month.month
  returning m.* into v_month;

  insert into public.ai_credit_ledger
    (user_id, month, kind, amount_micro_eur, reason, created_at)
  values
    (p_user_id, v_month.month, 'grant', p_amount_micro_eur, p_reason, p_now);

  select coalesce(sum(r.amount_micro_eur), 0) into v_reserved
  from public.ai_credit_reservations r
  where r.user_id = p_user_id and r.month = v_month.month
    and r.status = 'active' and r.expires_at > p_now;

  return v_month.allocation_micro_eur + v_month.granted_micro_eur
         - v_month.consumed_micro_eur - v_reserved;
end;
$$;

-- Fixe l'allocation mensuelle propre à un utilisateur (NULL = revenir à
-- l'allocation par défaut). S'applique tout de suite au mois en cours et aux
-- mois suivants ; les mois passés gardent leur allocation. Renvoie
-- l'allocation du mois en cours.
create or replace function public.set_ai_credit_allocation(
  p_user_id                    uuid,
  p_monthly_allocation_micro_eur bigint,
  p_now                        timestamptz default now()
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month      public.ai_credit_months;
  v_allocation bigint := coalesce(p_monthly_allocation_micro_eur,
                                  public.ai_credit_default_allocation());
begin
  if p_monthly_allocation_micro_eur < 0 then
    raise exception 'set_ai_credit_allocation : l''allocation doit être positive ou nulle'
      using errcode = '22023';
  end if;
  if p_user_id is null or p_now is null then
    raise exception 'set_ai_credit_allocation : utilisateur et date requis'
      using errcode = '22023';
  end if;

  v_month := public.ai_credit_lock_month(p_user_id, p_now);

  update public.ai_credit_accounts a
  set monthly_allocation_micro_eur = p_monthly_allocation_micro_eur,
      updated_at = p_now
  where a.user_id = p_user_id;

  update public.ai_credit_months m
  set allocation_micro_eur = v_allocation, updated_at = p_now
  where m.user_id = p_user_id and m.month = v_month.month;

  return v_allocation;
end;
$$;

-- Solde du mois de l'utilisateur COURANT (auth.uid()), pour l'en-tête et le
-- panneau « Crédit IA ». SECURITY INVOKER : lit les tables sous la RLS de
-- l'appelant, ne peut donc rien renvoyer d'un autre utilisateur.
-- Un utilisateur qui n'a encore rien consommé ce mois voit l'allocation
-- complète (les lignes du mois ne sont créées qu'à la première réservation).
-- remaining_micro_eur peut être légèrement négatif après un dépassement du
-- coût réel (cf. en-tête) ; l'interface affiche alors « épuisé ».
-- p_now : mois consulté (défaut : maintenant), pour l'historique.
create or replace function public.my_ai_credit(p_now timestamptz default now())
returns table (
  month                     date,
  allocation_micro_eur      bigint,
  granted_micro_eur         bigint,
  consumed_micro_eur        bigint,
  reserved_micro_eur        bigint,
  remaining_micro_eur       bigint,
  evaluations_count         integer,
  discussion_messages_count integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with me as (
    select (select auth.uid()) as user_id,
           date_trunc('month', p_now at time zone 'Europe/Paris')::date as month
  ),
  bal as (
    select me.month,
           coalesce(
             m.allocation_micro_eur,
             (select a.monthly_allocation_micro_eur
              from public.ai_credit_accounts a where a.user_id = me.user_id),
             public.ai_credit_default_allocation()
           ) as allocation,
           coalesce(m.granted_micro_eur, 0) as granted,
           coalesce(m.consumed_micro_eur, 0) as consumed,
           coalesce((
             select sum(r.amount_micro_eur)
             from public.ai_credit_reservations r
             where r.user_id = me.user_id and r.month = me.month
               and r.status = 'active' and r.expires_at > p_now
           ), 0)::bigint as reserved,
           (select count(*) from public.ai_credit_reservations r
            where r.user_id = me.user_id and r.month = me.month
              and r.status = 'settled' and r.kind = 'evaluation')::integer as evaluations,
           (select count(*) from public.ai_credit_reservations r
            where r.user_id = me.user_id and r.month = me.month
              and r.status = 'settled' and r.kind = 'discussion')::integer as discussions
    from me
    left join public.ai_credit_months m
      on m.user_id = me.user_id and m.month = me.month
    where me.user_id is not null
  )
  select bal.month, bal.allocation, bal.granted, bal.consumed, bal.reserved,
         bal.allocation + bal.granted - bal.consumed - bal.reserved,
         bal.evaluations, bal.discussions
  from bal;
$$;

-- -----------------------------------------------------------------------------
-- 4. Privilèges
--    Supabase accorde par défaut ALL à anon, authenticated et service_role sur
--    les nouvelles tables, et EXECUTE à PUBLIC sur les fonctions : on repart
--    de zéro et on accorde le strict nécessaire. Aucune écriture directe sur
--    les tables, même pour service_role : tout passe par les fonctions.
-- -----------------------------------------------------------------------------

revoke all on table
  public.ai_credit_accounts, public.ai_credit_months,
  public.ai_credit_reservations, public.ai_credit_ledger
from anon, authenticated, service_role, public;

-- authenticated : lecture de SES lignes (RLS).
grant select on
  public.ai_credit_accounts, public.ai_credit_months,
  public.ai_credit_reservations, public.ai_credit_ledger
to authenticated;

-- service_role (serveur, api/ ; script de l'opérateur) : lecture seule.
grant select on
  public.ai_credit_accounts, public.ai_credit_months,
  public.ai_credit_reservations, public.ai_credit_ledger
to service_role;

-- Fonctions ---------------------------------------------------------------------
revoke all on function public.ai_credit_ledger_immutable()
  from public, anon, authenticated, service_role;
revoke all on function public.ai_credit_lock_month(uuid, timestamptz)
  from public, anon, authenticated, service_role;

revoke all on function public.ai_credit_default_allocation()
  from public, anon, authenticated, service_role;
grant execute on function public.ai_credit_default_allocation()
  to authenticated, service_role;

revoke all on function public.my_ai_credit(timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.my_ai_credit(timestamptz) to authenticated;

revoke all on function
  public.reserve_ai_credit(uuid, bigint, text, text, uuid, uuid, uuid, interval, timestamptz),
  public.settle_ai_credit(uuid, bigint, jsonb, uuid, timestamptz),
  public.release_ai_credit(uuid, timestamptz),
  public.expire_ai_credit_reservations(timestamptz),
  public.grant_ai_credit(uuid, bigint, text, timestamptz),
  public.set_ai_credit_allocation(uuid, bigint, timestamptz)
from public, anon, authenticated, service_role;

grant execute on function
  public.reserve_ai_credit(uuid, bigint, text, text, uuid, uuid, uuid, interval, timestamptz),
  public.settle_ai_credit(uuid, bigint, jsonb, uuid, timestamptz),
  public.release_ai_credit(uuid, timestamptz),
  public.expire_ai_credit_reservations(timestamptz),
  public.grant_ai_credit(uuid, bigint, text, timestamptz),
  public.set_ai_credit_allocation(uuid, bigint, timestamptz)
to service_role;

-- -----------------------------------------------------------------------------
-- 5. Row Level Security (mêmes choix que les migrations précédentes : pas de
--    FORCE, une politique par opération, rôle authenticated uniquement).
--    SELECT seulement, sur ses propres lignes : l'absence de politique et de
--    privilège d'écriture refuse toute écriture cliente. service_role
--    contourne la RLS (BYPASSRLS) et n'est limité que par ses privilèges ; les
--    fonctions SECURITY DEFINER s'exécutent en propriétaire (pas de FORCE).
-- -----------------------------------------------------------------------------

alter table public.ai_credit_accounts     enable row level security;
alter table public.ai_credit_months       enable row level security;
alter table public.ai_credit_reservations enable row level security;
alter table public.ai_credit_ledger       enable row level security;

drop policy if exists ai_credit_accounts_select on public.ai_credit_accounts;
create policy ai_credit_accounts_select on public.ai_credit_accounts
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists ai_credit_months_select on public.ai_credit_months;
create policy ai_credit_months_select on public.ai_credit_months
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists ai_credit_reservations_select on public.ai_credit_reservations;
create policy ai_credit_reservations_select on public.ai_credit_reservations
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists ai_credit_ledger_select on public.ai_credit_ledger;
create policy ai_credit_ledger_select on public.ai_credit_ledger
  for select to authenticated
  using (user_id = (select auth.uid()));

reset statement_timeout;
reset lock_timeout;
