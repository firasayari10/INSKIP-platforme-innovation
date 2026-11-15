-- =============================================================================
-- Tests pgTAP de la migration « crédits IA » (supabase test db).
-- Tout s'exécute dans une transaction annulée à la fin : aucune donnée ne reste.
-- Utilisateurs simulés comme le fait PostgREST : rôle authenticated (ou anon)
-- + claims JWT dans request.jwt.claims. Le serveur (api/) et le script de
-- l'opérateur sont simulés par le rôle service_role. Les dates sont injectées
-- par p_now (aucune dépendance à l'horloge). Données entièrement fictives.
--
-- Concurrence : une transaction pgTAP n'a qu'une session ; « deux
-- réservations qui dépasseraient ensemble le solde » est donc vérifié en
-- séquence. La sérialisation réelle repose sur le « select … for update » de
-- la ligne du mois (ai_credit_lock_month), seul chemin d'écriture.
-- =============================================================================
begin;

create extension if not exists pgtap with schema extensions;

select plan(101);

-- -----------------------------------------------------------------------------
-- Préparation (rôle propriétaire de la base)
-- -----------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'proprietaire@exemple.test'),
  ('33333333-3333-3333-3333-333333333333', 'evaluateur@exemple.test'),
  ('44444444-4444-4444-4444-444444444444', 'autre@exemple.test');

create temporary table ctx (k text primary key, v jsonb not null);
grant select, insert, update on ctx to authenticated, anon, service_role;

create function pg_temp.ctx_uuid(p_key text) returns uuid
language sql stable as $$ select (v #>> '{}')::uuid from ctx where k = p_key $$;

create function pg_temp.as_user(p_sub text) returns void
language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
$$;

create function pg_temp.as_server() returns void
language sql as $$
  select set_config('request.jwt.claims', '{"role": "service_role"}', true);
$$;

-- =============================================================================
-- Structure et privilèges
-- =============================================================================
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relrowsecurity and not c.relforcerowsecurity
     and c.relname in ('ai_credit_accounts', 'ai_credit_months',
                       'ai_credit_reservations', 'ai_credit_ledger')),
  4, 'la RLS est activée (sans FORCE) sur les quatre tables de crédit');

select is(
  (select string_agg(tablename || ':' || cmd || ':' || array_to_string(roles, ','), ' '
                     order by tablename)
   from pg_policies
   where schemaname = 'public' and tablename like 'ai_credit_%'),
  'ai_credit_accounts:SELECT:authenticated ai_credit_ledger:SELECT:authenticated '
  || 'ai_credit_months:SELECT:authenticated ai_credit_reservations:SELECT:authenticated',
  'une seule politique par table : SELECT pour authenticated');

select ok(
  (select bool_and(
     has_table_privilege('authenticated', t, 'select')
     and not has_any_column_privilege('authenticated', t, 'insert')
     and not has_any_column_privilege('authenticated', t, 'update')
     and not has_table_privilege('authenticated', t, 'delete')
     and not has_table_privilege('authenticated', t, 'truncate'))
   from unnest(array['public.ai_credit_accounts', 'public.ai_credit_months',
                     'public.ai_credit_reservations', 'public.ai_credit_ledger']) t),
  'authenticated : lecture seule sur les tables de crédit');

select ok(
  (select bool_and(
     not has_any_column_privilege('anon', t, 'select')
     and not has_any_column_privilege('anon', t, 'insert')
     and not has_any_column_privilege('anon', t, 'update')
     and not has_table_privilege('anon', t, 'delete')
     and not has_table_privilege('anon', t, 'truncate'))
   from unnest(array['public.ai_credit_accounts', 'public.ai_credit_months',
                     'public.ai_credit_reservations', 'public.ai_credit_ledger']) t),
  'anon n''a aucun droit sur les tables de crédit');

select ok(
  (select bool_and(
     has_table_privilege('service_role', t, 'select')
     and not has_any_column_privilege('service_role', t, 'insert')
     and not has_any_column_privilege('service_role', t, 'update')
     and not has_table_privilege('service_role', t, 'delete')
     and not has_table_privilege('service_role', t, 'truncate'))
   from unnest(array['public.ai_credit_accounts', 'public.ai_credit_months',
                     'public.ai_credit_reservations', 'public.ai_credit_ledger']) t),
  'service_role : lecture seule, écritures uniquement par les fonctions');

select ok(
  (select bool_and(not has_function_privilege('anon', f, 'execute'))
   from unnest(array[
     'public.reserve_ai_credit(uuid, bigint, text, text, uuid, uuid, uuid, interval, timestamptz)',
     'public.settle_ai_credit(uuid, bigint, jsonb, uuid, timestamptz)',
     'public.release_ai_credit(uuid, timestamptz)',
     'public.expire_ai_credit_reservations(timestamptz)',
     'public.grant_ai_credit(uuid, bigint, text, timestamptz)',
     'public.set_ai_credit_allocation(uuid, bigint, timestamptz)',
     'public.ai_credit_lock_month(uuid, timestamptz)',
     'public.ai_credit_ledger_immutable()',
     'public.ai_credit_default_allocation()',
     'public.my_ai_credit(timestamptz)']) f),
  'anon n''exécute aucune fonction de crédit');

select ok(
  (select bool_and(not has_function_privilege('authenticated', f, 'execute'))
   from unnest(array[
     'public.reserve_ai_credit(uuid, bigint, text, text, uuid, uuid, uuid, interval, timestamptz)',
     'public.settle_ai_credit(uuid, bigint, jsonb, uuid, timestamptz)',
     'public.release_ai_credit(uuid, timestamptz)',
     'public.expire_ai_credit_reservations(timestamptz)',
     'public.grant_ai_credit(uuid, bigint, text, timestamptz)',
     'public.set_ai_credit_allocation(uuid, bigint, timestamptz)',
     'public.ai_credit_lock_month(uuid, timestamptz)',
     'public.ai_credit_ledger_immutable()']) f),
  'authenticated n''exécute aucune fonction d''écriture de crédit');

select ok(
  (select bool_and(has_function_privilege('service_role', f, 'execute'))
   from unnest(array[
     'public.reserve_ai_credit(uuid, bigint, text, text, uuid, uuid, uuid, interval, timestamptz)',
     'public.settle_ai_credit(uuid, bigint, jsonb, uuid, timestamptz)',
     'public.release_ai_credit(uuid, timestamptz)',
     'public.expire_ai_credit_reservations(timestamptz)',
     'public.grant_ai_credit(uuid, bigint, text, timestamptz)',
     'public.set_ai_credit_allocation(uuid, bigint, timestamptz)']) f)
  and not has_function_privilege('service_role', 'public.ai_credit_lock_month(uuid, timestamptz)', 'execute'),
  'service_role exécute les six fonctions d''écriture, pas la fonction interne de verrou');

select ok(
  has_function_privilege('authenticated', 'public.my_ai_credit(timestamptz)', 'execute'),
  'authenticated exécute my_ai_credit');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and p.proconfig @> array['search_path=""']
     and p.proname in ('reserve_ai_credit', 'settle_ai_credit', 'release_ai_credit',
                       'expire_ai_credit_reservations', 'grant_ai_credit',
                       'set_ai_credit_allocation', 'ai_credit_lock_month')),
  7, 'les fonctions d''écriture sont SECURITY DEFINER avec search_path vide');

select ok(
  (select not p.prosecdef from pg_proc p where p.oid = 'public.my_ai_credit(timestamptz)'::regprocedure),
  'my_ai_credit est SECURITY INVOKER (lit sous la RLS de l''appelant)');

-- =============================================================================
-- Données : c1 (owner 1111, évaluateur 3333 membre), c2 (owner 4444)
-- =============================================================================
set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');

with c as (
  insert into public.challenges (title, client_name)
  values ('Challenge Hexavia 2026', 'Hexavia') returning id)
insert into ctx (k, v) select 'c1', to_jsonb(id) from c;

insert into public.challenge_members (challenge_id, user_id)
values (pg_temp.ctx_uuid('c1'), '33333333-3333-3333-3333-333333333333');

with i as (
  insert into public.ideas (challenge_id, external_ref, title, description, content_hash)
  values (pg_temp.ctx_uuid('c1'), 'IDEA-001', 'Capteurs de vibration',
          'Détecter l''usure des compresseurs avant la panne.', repeat('a', 64))
  returning id)
insert into ctx (k, v) select 'idea1', to_jsonb(id) from i;

select pg_temp.as_user('44444444-4444-4444-4444-444444444444');

with c as (
  insert into public.challenges (title, client_name)
  values ('Autre challenge', 'Autre client') returning id)
insert into ctx (k, v) select 'c2', to_jsonb(id) from c;

with i as (
  insert into public.ideas (challenge_id, external_ref, title, description, content_hash)
  values (pg_temp.ctx_uuid('c2'), 'IDEA-900', 'Covoiturage interne',
          'Mettre en relation les salariés d''un même site.', repeat('b', 64))
  returning id)
insert into ctx (k, v) select 'idea2', to_jsonb(id) from i;

-- =============================================================================
-- Serveur (service_role) : réservations du 15 novembre 2026, 10 h (Paris)
-- =============================================================================
set local role service_role;
select pg_temp.as_server();

with e as (
  insert into public.evaluations (challenge_id, idea_id, prompt_version, content_hash, requested_by)
  values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), '1.2', repeat('a', 64),
          '33333333-3333-3333-3333-333333333333')
  returning id)
insert into ctx (k, v) select 'eval1', to_jsonb(id) from e;

-- Réservation ---------------------------------------------------------------
select lives_ok(
  $$ insert into ctx (k, v)
     select 'r1', to_jsonb(public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 3000000, 'evaluation', 'eval:job1:1',
       pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), null, interval '30 minutes',
       '2026-11-15 10:00:00+01')) $$,
  'le serveur réserve 3 € pour une évaluation');

select is(
  (select row(m.month, m.allocation_micro_eur, m.granted_micro_eur, m.consumed_micro_eur)::text
   from public.ai_credit_months m
   where m.user_id = '33333333-3333-3333-3333-333333333333'),
  row('2026-11-01'::date, 5000000::bigint, 0::bigint, 0::bigint)::text,
  'compte et mois ouverts à la première réservation : allocation 5 €, rien consommé');

select is(
  (select row(r.status, r.amount_micro_eur, r.month, r.expires_at)::text
   from public.ai_credit_reservations r where r.id = pg_temp.ctx_uuid('r1')),
  row('active'::text, 3000000::bigint, '2026-11-01'::date,
      '2026-11-15 10:30:00+01'::timestamptz)::text,
  'la réservation est active, rattachée à novembre, et échoit 30 minutes plus tard');

select is(
  public.reserve_ai_credit(
    '33333333-3333-3333-3333-333333333333', 3000000, 'evaluation', 'eval:job1:1',
    pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), null, interval '30 minutes',
    '2026-11-15 10:01:00+01'),
  pg_temp.ctx_uuid('r1'),
  'une demande rejouée (même clé) renvoie la même réservation');

select is(
  (select count(*)::int from public.ai_credit_reservations
   where user_id = '33333333-3333-3333-3333-333333333333'),
  1, 'le rejeu n''a pas réservé une seconde fois');

select throws_ok(
  $$ select public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 3000000, 'discussion', 'eval:job1:1',
       pg_temp.ctx_uuid('c1'), null, null, interval '30 minutes', '2026-11-15 10:01:00+01') $$,
  '22023', null, 'une clé déjà utilisée pour une autre opération est refusée');

-- Deux réservations qui dépasseraient ensemble le solde ----------------------
select throws_ok(
  $$ select public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 2000001, 'discussion', 'chat:m1',
       pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), null, interval '30 minutes',
       '2026-11-15 10:02:00+01') $$,
  'CI001', 'credit_ia_epuise',
  'la seconde réservation qui dépasserait le solde (3 € + 2,000001 € > 5 €) est refusée');

select lives_ok(
  $$ insert into ctx (k, v)
     select 'r2', to_jsonb(public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 2000000, 'discussion', 'chat:m1',
       pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), null, interval '30 minutes',
       '2026-11-15 10:02:00+01')) $$,
  'une réservation qui épuise exactement le solde est acceptée');

select throws_ok(
  $$ select public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 1, 'discussion', 'chat:m2',
       pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), null, interval '30 minutes',
       '2026-11-15 10:03:00+01') $$,
  'CI001', 'credit_ia_epuise', 'solde nul : même 1 µ€ est refusé');

-- Paramètres refusés ----------------------------------------------------------
select throws_ok(
  $$ select public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', -5, 'evaluation', 'eval:neg',
       pg_temp.ctx_uuid('c1'), null, null, interval '30 minutes', '2026-11-15 10:03:00+01') $$,
  '22023', null, 'un montant de réservation négatif est refusé');

select throws_ok(
  $$ select public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 0, 'evaluation', 'eval:zero',
       pg_temp.ctx_uuid('c1'), null, null, interval '30 minutes', '2026-11-15 10:03:00+01') $$,
  '22023', null, 'un montant de réservation nul est refusé');

select throws_ok(
  $$ select public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 10, 'chat', 'x:1',
       pg_temp.ctx_uuid('c1'), null, null, interval '30 minutes', '2026-11-15 10:03:00+01') $$,
  '22023', null, 'un type d''opération inconnu est refusé');

select throws_ok(
  $$ select public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 10, 'evaluation', repeat('k', 121),
       pg_temp.ctx_uuid('c1'), null, null, interval '30 minutes', '2026-11-15 10:03:00+01') $$,
  '22023', null, 'une clé d''idempotence de plus de 120 caractères est refusée');

select throws_ok(
  $$ select public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 10, 'evaluation', 'eval:ttl',
       pg_temp.ctx_uuid('c1'), null, null, interval '2 days', '2026-11-15 10:03:00+01') $$,
  '22023', null, 'une durée de réservation de plus d''un jour est refusée');

select throws_ok(
  $$ select public.reserve_ai_credit(
       '44444444-4444-4444-4444-444444444444', 10, 'evaluation', 'eval:intrus',
       pg_temp.ctx_uuid('c1'), null, null, interval '30 minutes', '2026-11-15 10:03:00+01') $$,
  '42501', null, 'un utilisateur non membre du challenge ne peut pas réserver dessus');

select throws_ok(
  $$ select public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 10, 'evaluation', 'eval:autre-idee',
       pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea2'), null, interval '30 minutes',
       '2026-11-15 10:03:00+01') $$,
  '22023', null, 'une idée d''un autre challenge est refusée');

-- Régularisation au coût réel -------------------------------------------------
select throws_ok(
  $$ select public.settle_ai_credit(pg_temp.ctx_uuid('r1'), -1, '[]', null,
                                     '2026-11-15 10:10:00+01') $$,
  '22023', null, 'un coût réel négatif est refusé');

select throws_ok(
  $$ select public.settle_ai_credit(pg_temp.ctx_uuid('r1'), 0,
       '[{"agent": "analyste", "model": "glm-test", "input_tokens": 10,
          "output_tokens": 5, "cost_micro_eur": -100},
         {"agent": "associe", "model": "glm-test", "input_tokens": 10,
          "output_tokens": 5, "cost_micro_eur": 100}]', null,
       '2026-11-15 10:10:00+01') $$,
  '22023', null, 'un appel au coût négatif est refusé (même si la somme est juste)');

select throws_ok(
  $$ select public.settle_ai_credit(pg_temp.ctx_uuid('r1'), 1200000,
       '[{"agent": "analyste", "model": "glm-test", "input_tokens": 10,
          "output_tokens": 5, "cost_micro_eur": 100}]', null,
       '2026-11-15 10:10:00+01') $$,
  '22023', null, 'une somme des appels différente du coût réel est refusée');

select throws_ok(
  $$ select public.settle_ai_credit(pg_temp.ctx_uuid('r1'), 100,
       '[{"agent": "analyste", "model": "glm-test", "input_tokens": 10,
          "output_tokens": 5, "cost_micro_eur": 99.5},
         {"agent": "associe", "model": "glm-test", "input_tokens": 10,
          "output_tokens": 5, "cost_micro_eur": 0.5}]', null,
       '2026-11-15 10:10:00+01') $$,
  '22023', null, 'un coût d''appel non entier (fraction de µ€) est refusé');

select throws_ok(
  $$ select public.settle_ai_credit('99999999-9999-9999-9999-999999999999', 0, '[]', null,
                                     '2026-11-15 10:10:00+01') $$,
  'CI002', 'reservation_ia_introuvable', 'une réservation inconnue est signalée');

select is(
  public.settle_ai_credit(pg_temp.ctx_uuid('r1'), 1200000,
    '[{"agent": "analyste", "model": "glm-test", "input_tokens": 1000,
       "output_tokens": 200, "cost_micro_eur": 200000},
      {"agent": "associe", "model": "glm-test", "input_tokens": 4000,
       "output_tokens": 900, "cost_micro_eur": 1000000, "cached_tokens": 1000,
       "web_searches": 1}]',
    pg_temp.ctx_uuid('eval1'), '2026-11-15 10:10:00+01'),
  1800000::bigint,
  'régularisation à 1,20 € : le reliquat de 1,80 € est rendu');

select is(
  (select row(r.status, r.consumed_micro_eur, r.evaluation_id, r.closed_at)::text
   from public.ai_credit_reservations r where r.id = pg_temp.ctx_uuid('r1')),
  row('settled'::text, 1200000::bigint, pg_temp.ctx_uuid('eval1'),
      '2026-11-15 10:10:00+01'::timestamptz)::text,
  'la réservation est régularisée, avec son coût réel et son évaluation');

select is(
  (select string_agg(
            concat_ws('|', l.kind, l.operation, l.agent, l.model, l.amount_micro_eur,
                      l.input_tokens, l.output_tokens, l.cached_tokens, l.web_searches,
                      l.estimated, l.challenge_id = pg_temp.ctx_uuid('c1'),
                      l.idea_id = pg_temp.ctx_uuid('idea1'),
                      l.evaluation_id = pg_temp.ctx_uuid('eval1'), l.month),
            ' ' order by l.id)
   from public.ai_credit_ledger l where l.reservation_id = pg_temp.ctx_uuid('r1')),
  'usage|evaluation|analyste|glm-test|200000|1000|200|0|0|f|t|t|t|2026-11-01 '
  || 'usage|evaluation|associe|glm-test|1000000|4000|900|1000|1|f|t|t|t|2026-11-01',
  'un événement de journal par appel facturé, rattaché à l''utilisateur, au challenge, à l''idée et à l''évaluation');

select is(
  (select consumed_micro_eur from public.ai_credit_months
   where user_id = '33333333-3333-3333-3333-333333333333' and month = '2026-11-01'),
  1200000::bigint, 'le mois porte la consommation réelle');

select throws_ok(
  $$ select public.settle_ai_credit(pg_temp.ctx_uuid('r1'), 1200000,
       '[{"agent": "associe", "model": "glm-test", "input_tokens": 1,
          "output_tokens": 1, "cost_micro_eur": 1200000}]', null,
       '2026-11-15 10:11:00+01') $$,
  'CI003', 'reservation_ia_deja_cloturee', 'une double régularisation est refusée');

select is(
  (select row(m.consumed_micro_eur,
              (select count(*) from public.ai_credit_ledger l
               where l.reservation_id = pg_temp.ctx_uuid('r1')))::text
   from public.ai_credit_months m
   where m.user_id = '33333333-3333-3333-3333-333333333333' and m.month = '2026-11-01'),
  row(1200000::bigint, 2::bigint)::text,
  'la double régularisation n''a rien compté ni journalisé');

select throws_ok(
  $$ select public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 3000000, 'evaluation', 'eval:job1:1',
       pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), null, interval '30 minutes',
       '2026-11-15 10:12:00+01') $$,
  'CI003', 'reservation_ia_deja_cloturee',
  'rejouer la clé d''une réservation régularisée ne réserve pas de nouveau');

-- Le reliquat est disponible : 5 − 1,2 − 2 (r2) = 1,8 € ------------------------
select throws_ok(
  $$ select public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 1800001, 'evaluation', 'eval:job2:1',
       pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), null, interval '30 minutes',
       '2026-11-15 10:12:00+01') $$,
  'CI001', 'credit_ia_epuise', 'au-delà du reliquat (1,80 €), la réservation est refusée');

-- Libération --------------------------------------------------------------------
select is(
  public.release_ai_credit(pg_temp.ctx_uuid('r2'), '2026-11-15 10:13:00+01'),
  true, 'le serveur libère une réservation sans consommation');

select is(
  public.release_ai_credit(pg_temp.ctx_uuid('r2'), '2026-11-15 10:14:00+01'),
  false, 'libérer une seconde fois est sans effet');

select throws_ok(
  $$ select public.settle_ai_credit(pg_temp.ctx_uuid('r2'), 0, '[]', null,
                                     '2026-11-15 10:14:00+01') $$,
  'CI003', 'reservation_ia_deja_cloturee', 'une réservation libérée ne peut plus être régularisée');

-- Expiration : disponible 3,8 € -----------------------------------------------
select lives_ok(
  $$ insert into ctx (k, v)
     select 'r3', to_jsonb(public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 3800000, 'discussion', 'chat:m3',
       pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), null, interval '30 minutes',
       '2026-11-15 10:15:00+01')) $$,
  'le serveur réserve tout le disponible (3,80 €)');

select throws_ok(
  $$ select public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 1, 'discussion', 'chat:m4',
       pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), null, interval '30 minutes',
       '2026-11-15 10:44:00+01') $$,
  'CI001', 'credit_ia_epuise', 'tant qu''elle n''est pas échue, la réservation bloque le solde');

select lives_ok(
  $$ insert into ctx (k, v)
     select 'r4', to_jsonb(public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 3800000, 'evaluation', 'eval:job3:1',
       pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), null, interval '30 minutes',
       '2026-11-15 10:46:00+01')) $$,
  'une réservation échue (serveur tombé) ne compte plus : 3,80 € de nouveau réservables');

select is(
  (select row(r.status, r.closed_at)::text from public.ai_credit_reservations r
   where r.id = pg_temp.ctx_uuid('r3')),
  row('expired'::text, '2026-11-15 10:46:00+01'::timestamptz)::text,
  'la réservation échue est marquée expirée à la réservation suivante');

select is(
  public.settle_ai_credit(pg_temp.ctx_uuid('r3'), 0, '[]', null, '2026-11-15 10:50:00+01'),
  3800000::bigint,
  'une réservation échue peut encore être régularisée (appels déjà payés)');

select is(
  public.expire_ai_credit_reservations('2026-11-15 12:00:00+01'),
  1, 'la tâche de nettoyage expire la réservation échue restante');

select is(
  (select status from public.ai_credit_reservations where id = pg_temp.ctx_uuid('r4')),
  'expired', 'la réservation r4 est expirée');

select is(
  public.expire_ai_credit_reservations('2026-11-15 12:00:00+01'),
  0, 'relancer le nettoyage est sans effet');

select throws_ok(
  $$ select public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 3800000, 'evaluation', 'eval:job3:1',
       pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), null, interval '30 minutes',
       '2026-11-15 12:01:00+01') $$,
  'CI003', 'reservation_ia_deja_cloturee',
  'rejouer la clé d''une réservation expirée est refusé');

-- Changement de mois (fuseau Europe/Paris) -------------------------------------
-- 30/11 23 h 30 UTC = 1er décembre 0 h 30 à Paris : nouveau mois.
select lives_ok(
  $$ insert into ctx (k, v)
     select 'r5', to_jsonb(public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 5000000, 'evaluation', 'eval:job4:1',
       pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), null, interval '30 minutes',
       '2026-11-30 23:30:00+00')) $$,
  'le 1er décembre (heure de Paris), le solde repart à 5 € : 5 € réservables');

select is(
  (select string_agg(m.month || ':' || m.allocation_micro_eur || ':' || m.consumed_micro_eur,
                     ' ' order by m.month)
   from public.ai_credit_months m
   where m.user_id = '33333333-3333-3333-3333-333333333333'),
  '2026-11-01:5000000:1200000 2026-12-01:5000000:0',
  'novembre garde son historique, décembre est un nouveau mois');

-- Recrédit par l'opérateur ------------------------------------------------------
select is(
  public.grant_ai_credit('33333333-3333-3333-3333-333333333333', 1000000,
                         'Complément pour le challenge de démonstration',
                         '2026-11-30 23:40:00+00'),
  1000000::bigint,
  'l''opérateur recrédite 1 € en décembre : restant 5 + 1 − 5 réservés = 1 €');

select throws_ok(
  $$ select public.grant_ai_credit('33333333-3333-3333-3333-333333333333', -1000000,
                                    'Retrait', '2026-11-30 23:40:00+00') $$,
  '22023', null, 'un recrédit négatif est refusé');

select throws_ok(
  $$ select public.grant_ai_credit('33333333-3333-3333-3333-333333333333', 1000000,
                                    '', '2026-11-30 23:40:00+00') $$,
  '22023', null, 'un recrédit sans raison est refusé');

select throws_ok(
  $$ select public.grant_ai_credit('99999999-9999-9999-9999-999999999999', 1000000,
                                    'Utilisateur inconnu', '2026-11-30 23:40:00+00') $$,
  '23503', null, 'un recrédit pour un utilisateur inexistant est refusé');

-- Allocation propre à un utilisateur -------------------------------------------
select is(
  public.set_ai_credit_allocation('44444444-4444-4444-4444-444444444444', 10000000,
                                  '2026-11-15 10:00:00+01'),
  10000000::bigint, 'l''opérateur porte l''allocation mensuelle d''un utilisateur à 10 €');

select throws_ok(
  $$ select public.set_ai_credit_allocation('44444444-4444-4444-4444-444444444444', -1,
                                             '2026-11-15 10:00:00+01') $$,
  '22023', null, 'une allocation négative est refusée');

select lives_ok(
  $$ insert into ctx (k, v)
     select 'r6', to_jsonb(public.reserve_ai_credit(
       '44444444-4444-4444-4444-444444444444', 8000000, 'evaluation', 'eval:autre:1',
       pg_temp.ctx_uuid('c2'), pg_temp.ctx_uuid('idea2'), null, interval '30 minutes',
       '2026-11-15 10:05:00+01')) $$,
  'avec 10 € d''allocation, 8 € sont réservables');

select is(
  public.settle_ai_credit(pg_temp.ctx_uuid('r6'), 400000,
    '[{"agent": "consultant", "model": "glm-test", "input_tokens": 2000,
       "output_tokens": 400, "cost_micro_eur": 400000, "estimated": true}]',
    null, '2026-11-15 10:06:00+01'),
  7600000::bigint, 'régularisation d''un appel au coût estimé (délai dépassé)');

-- Journal immuable, aucune écriture directe -----------------------------------
select throws_ok(
  $$ update public.ai_credit_ledger set amount_micro_eur = 0 $$,
  '42501', null, 'le serveur ne peut pas modifier le journal');

select throws_ok(
  $$ delete from public.ai_credit_ledger $$,
  '42501', null, 'le serveur ne peut pas supprimer le journal');

select throws_ok(
  $$ insert into public.ai_credit_ledger (user_id, month, kind, amount_micro_eur, reason)
     values ('33333333-3333-3333-3333-333333333333', '2026-11-01', 'grant', 1000000, 'x') $$,
  '42501', null, 'le serveur ne peut pas écrire directement dans le journal');

select throws_ok(
  $$ update public.ai_credit_months set granted_micro_eur = 99000000 $$,
  '42501', null, 'le serveur ne peut pas modifier directement un solde');

select throws_ok(
  $$ update public.ai_credit_reservations set status = 'released' $$,
  '42501', null, 'le serveur ne peut pas modifier directement une réservation');

-- =============================================================================
-- Propriétaire de la base : invariants et immuabilité
-- =============================================================================
reset role;

select is(
  (select count(*)::int from public.ai_credit_months m
   where m.consumed_micro_eur <> coalesce((
           select sum(l.amount_micro_eur) from public.ai_credit_ledger l
           where l.user_id = m.user_id and l.month = m.month and l.kind = 'usage'), 0)
      or m.granted_micro_eur <> coalesce((
           select sum(l.amount_micro_eur) from public.ai_credit_ledger l
           where l.user_id = m.user_id and l.month = m.month and l.kind = 'grant'), 0)),
  0, 'invariant : consommé et recrédité de chaque mois = sommes du journal');

select throws_ok(
  $$ update public.ai_credit_ledger set amount_micro_eur = 0 $$,
  '42501', null, 'même le propriétaire ne peut pas modifier le journal');

select throws_ok(
  $$ delete from public.ai_credit_ledger $$,
  '42501', null, 'même le propriétaire ne peut pas supprimer le journal');

select throws_ok(
  $$ truncate public.ai_credit_ledger $$,
  '42501', null, 'même le propriétaire ne peut pas vider le journal');

select throws_ok(
  $$ insert into public.ai_credit_ledger (user_id, month, kind, amount_micro_eur)
     values ('33333333-3333-3333-3333-333333333333', '2026-11-01', 'grant', 1000000) $$,
  '23514', null, 'un recrédit sans raison est refusé par la table');

select throws_ok(
  $$ insert into public.ai_credit_ledger (user_id, month, kind, amount_micro_eur, reason)
     values ('33333333-3333-3333-3333-333333333333', '2026-11-01', 'usage', 10, 'x') $$,
  '23514', null, 'un usage sans réservation, agent ni modèle est refusé par la table');

select throws_ok(
  $$ insert into public.ai_credit_months (user_id, month, allocation_micro_eur)
     values ('33333333-3333-3333-3333-333333333333', '2026-10-15', 0) $$,
  '23514', null, 'un mois doit commencer le 1er');

-- =============================================================================
-- Évaluateur 3333 : ne lit que SES lignes et son solde
-- =============================================================================
set local role authenticated;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');

select is(
  (select row(c.*)::text from public.my_ai_credit('2026-11-15 12:00:00+01') c),
  row('2026-11-01'::date, 5000000::bigint, 0::bigint, 1200000::bigint, 0::bigint,
      3800000::bigint, 1, 1)::text,
  'solde de novembre : 5 € alloués, 1,20 € consommés, rien en cours, 3,80 € restants, 1 évaluation, 1 message');

select is(
  (select row(c.*)::text from public.my_ai_credit('2026-11-30 23:45:00+00') c),
  row('2026-12-01'::date, 5000000::bigint, 1000000::bigint, 0::bigint, 5000000::bigint,
      1000000::bigint, 0, 0)::text,
  'solde de décembre : 5 € + 1 € recrédité, 5 € réservés en cours, 1 € restant');

select is(
  (select row(c.reserved_micro_eur, c.remaining_micro_eur)::text
   from public.my_ai_credit('2026-12-01 01:00:00+01') c),
  row(0::bigint, 6000000::bigint)::text,
  'à l''échéance de la réservation, elle ne compte plus dans le solde affiché');

select is(
  (select count(*)::int from public.ai_credit_ledger),
  3, 'l''évaluateur voit ses 3 lignes de journal (2 appels, 1 recrédit)');

select is(
  (select count(*)::int from public.ai_credit_ledger
   where user_id <> '33333333-3333-3333-3333-333333333333')
  + (select count(*)::int from public.ai_credit_reservations
     where user_id <> '33333333-3333-3333-3333-333333333333')
  + (select count(*)::int from public.ai_credit_months
     where user_id <> '33333333-3333-3333-3333-333333333333')
  + (select count(*)::int from public.ai_credit_accounts
     where user_id <> '33333333-3333-3333-3333-333333333333'),
  0, 'l''évaluateur ne voit aucune ligne d''un autre utilisateur');

select is(
  (select count(*)::int from public.ai_credit_reservations),
  5, 'l''évaluateur voit ses 5 réservations');

select throws_ok(
  $$ insert into public.ai_credit_ledger (user_id, month, kind, amount_micro_eur, reason)
     values ('33333333-3333-3333-3333-333333333333', '2026-11-01', 'grant', 99000000, 'moi') $$,
  '42501', null, 'l''évaluateur ne peut pas se recréditer par le journal');

select throws_ok(
  $$ update public.ai_credit_months set granted_micro_eur = 99000000 $$,
  '42501', null, 'l''évaluateur ne peut pas modifier son solde');

select throws_ok(
  $$ update public.ai_credit_accounts set monthly_allocation_micro_eur = 99000000 $$,
  '42501', null, 'l''évaluateur ne peut pas changer son allocation');

select throws_ok(
  $$ delete from public.ai_credit_reservations $$,
  '42501', null, 'l''évaluateur ne peut pas supprimer ses réservations');

select throws_ok(
  $$ select public.reserve_ai_credit(
       '33333333-3333-3333-3333-333333333333', 1, 'evaluation', 'eval:client',
       pg_temp.ctx_uuid('c1'), null, null, interval '30 minutes', now()) $$,
  '42501', null, 'l''évaluateur ne peut pas réserver lui-même');

select throws_ok(
  $$ select public.settle_ai_credit(pg_temp.ctx_uuid('r5'), 0, '[]', null, now()) $$,
  '42501', null, 'l''évaluateur ne peut pas régulariser lui-même');

-- =============================================================================
-- Autre utilisateur 4444 : allocation de 10 €
-- =============================================================================
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');

select is(
  (select row(c.allocation_micro_eur, c.consumed_micro_eur, c.remaining_micro_eur,
              c.evaluations_count)::text
   from public.my_ai_credit('2026-11-15 12:00:00+01') c),
  row(10000000::bigint, 400000::bigint, 9600000::bigint, 1)::text,
  'un autre utilisateur voit son propre solde (allocation de 10 €)');

select is(
  (select count(*)::int from public.ai_credit_ledger),
  1, 'il ne voit que sa propre ligne de journal');

-- =============================================================================
-- Owner du challenge 1111 : jamais consommé, ne peut pas recréditer
-- =============================================================================
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');

select is(
  (select row(c.*)::text from public.my_ai_credit('2026-11-15 12:00:00+01') c),
  row('2026-11-01'::date, 5000000::bigint, 0::bigint, 0::bigint, 0::bigint,
      5000000::bigint, 0, 0)::text,
  'un utilisateur sans consommation voit l''allocation complète');

select throws_ok(
  $$ select public.grant_ai_credit('33333333-3333-3333-3333-333333333333', 1000000,
                                    'Recrédit par l''owner', now()) $$,
  '42501', null, 'l''owner d''un challenge ne peut pas recréditer un membre');

select throws_ok(
  $$ select public.set_ai_credit_allocation('11111111-1111-1111-1111-111111111111',
                                             99000000, now()) $$,
  '42501', null, 'un utilisateur ne peut pas changer sa propre allocation');

-- =============================================================================
-- anon : rien
-- =============================================================================
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok($$ select count(*) from public.ai_credit_ledger $$, '42501', null,
  'anon ne lit pas le journal');
select throws_ok($$ select count(*) from public.ai_credit_months $$, '42501', null,
  'anon ne lit pas les soldes');
select throws_ok($$ select count(*) from public.ai_credit_reservations $$, '42501', null,
  'anon ne lit pas les réservations');
select throws_ok($$ select count(*) from public.ai_credit_accounts $$, '42501', null,
  'anon ne lit pas les comptes');
select throws_ok($$ select * from public.my_ai_credit() $$, '42501', null,
  'anon n''exécute pas my_ai_credit');
select throws_ok(
  $$ select public.grant_ai_credit('33333333-3333-3333-3333-333333333333', 1000000,
                                    'anon', now()) $$,
  '42501', null, 'anon ne peut pas recréditer');

-- =============================================================================
-- Suppression du challenge : le journal d'audit survit
-- =============================================================================
set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');

select lives_ok(
  $$ delete from public.challenges where id = pg_temp.ctx_uuid('c1') $$,
  'l''owner supprime le challenge malgré l''historique de consommation');

reset role;

select is(
  (select count(*)::int from public.ai_credit_ledger
   where challenge_id = pg_temp.ctx_uuid('c1') and kind = 'usage'),
  2, 'les appels facturés du challenge supprimé restent au journal (références conservées)');

select is(
  (select count(*)::int from public.ai_credit_reservations
   where challenge_id = pg_temp.ctx_uuid('c1')),
  5, 'les réservations du challenge supprimé restent (historique du solde)');

select throws_ok(
  $$ delete from auth.users where id = '33333333-3333-3333-3333-333333333333' $$,
  '23503', null, 'un utilisateur qui a un historique de crédit ne peut pas être supprimé (restrict)');

select * from finish();
rollback;
