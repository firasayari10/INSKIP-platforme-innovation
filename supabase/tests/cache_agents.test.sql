-- =============================================================================
-- Tests pgTAP de la migration « cache des sorties d'agents » (supabase test db).
-- Tout s'exécute dans une transaction annulée à la fin : aucune donnée ne reste.
-- Utilisateurs simulés comme le fait PostgREST : rôle authenticated (ou anon)
-- + claims JWT dans request.jwt.claims. Le serveur de notation est simulé
-- par le rôle service_role. Données entièrement fictives.
-- =============================================================================
begin;

create extension if not exists pgtap with schema extensions;

select plan(54);

-- -----------------------------------------------------------------------------
-- Préparation (rôle propriétaire de la base)
-- -----------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'proprietaire@exemple.test'),
  ('33333333-3333-3333-3333-333333333333', 'evaluateur@exemple.test');

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
select ok(
  (select relrowsecurity from pg_class where oid = 'public.agent_outputs'::regclass),
  'la RLS est activée sur agent_outputs');

select is(
  (select count(*)::int from pg_policies
   where schemaname = 'public' and tablename = 'agent_outputs'),
  0, 'agent_outputs n''a aucune politique (refus total aux clients)');

select ok(
  not has_any_column_privilege('authenticated', 'public.agent_outputs', 'select')
  and not has_any_column_privilege('authenticated', 'public.agent_outputs', 'insert')
  and not has_any_column_privilege('authenticated', 'public.agent_outputs', 'update')
  and not has_table_privilege('authenticated', 'public.agent_outputs', 'delete')
  and not has_table_privilege('authenticated', 'public.agent_outputs', 'truncate'),
  'authenticated n''a aucun droit sur agent_outputs');

select ok(
  not has_any_column_privilege('anon', 'public.agent_outputs', 'select')
  and not has_any_column_privilege('anon', 'public.agent_outputs', 'insert')
  and not has_any_column_privilege('anon', 'public.agent_outputs', 'update')
  and not has_table_privilege('anon', 'public.agent_outputs', 'delete')
  and not has_table_privilege('anon', 'public.agent_outputs', 'truncate'),
  'anon n''a aucun droit sur agent_outputs');

select ok(
  has_table_privilege('service_role', 'public.agent_outputs', 'select')
  and has_table_privilege('service_role', 'public.agent_outputs', 'insert')
  and not has_any_column_privilege('service_role', 'public.agent_outputs', 'update')
  and not has_table_privilege('service_role', 'public.agent_outputs', 'delete')
  and not has_table_privilege('service_role', 'public.agent_outputs', 'truncate'),
  'service_role lit et insère dans agent_outputs, sans modification ni suppression');

select ok(
  has_column_privilege('authenticated', 'public.evaluations', 'input_fingerprint', 'select')
  and not has_column_privilege('authenticated', 'public.evaluations', 'input_fingerprint', 'insert')
  and not has_column_privilege('authenticated', 'public.evaluations', 'input_fingerprint', 'update')
  and has_column_privilege('service_role', 'public.evaluations', 'input_fingerprint', 'insert')
  and has_column_privilege('service_role', 'public.evaluations', 'input_fingerprint', 'select'),
  'input_fingerprint : lue par authenticated, écrite par service_role seulement');

select ok(
  exists (select 1 from pg_indexes
          where schemaname = 'public' and tablename = 'agent_outputs'
            and indexname = 'agent_outputs_created_at_idx'),
  'agent_outputs est indexée par created_at (purge)');

select ok(
  exists (select 1 from pg_indexes
          where schemaname = 'public' and tablename = 'evaluations'
            and indexname = 'evaluations_idea_id_input_fingerprint_idx'
            and indexdef like '%(idea_id, input_fingerprint)%'
            and indexdef like '%WHERE (status = ''completed''::text)%'),
  'evaluations a l''index partiel (idea_id, input_fingerprint) des évaluations terminées');

-- =============================================================================
-- Données : deux challenges, un évaluateur membre du premier
-- =============================================================================
set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');

with c as (
  insert into public.challenges (title, client_name)
  values ('Challenge Hexavia 2026', 'Hexavia') returning id)
insert into ctx (k, v) select 'c1', to_jsonb(id) from c;

with c as (
  insert into public.challenges (title, client_name)
  values ('Autre challenge', 'Autre client') returning id)
insert into ctx (k, v) select 'c2', to_jsonb(id) from c;

insert into public.challenge_members (challenge_id, user_id)
values (pg_temp.ctx_uuid('c1'), '33333333-3333-3333-3333-333333333333');

with i as (
  insert into public.ideas (challenge_id, external_ref, title, description, content_hash)
  values (pg_temp.ctx_uuid('c1'), 'IDEA-001', 'Capteurs de vibration',
          'Détecter l''usure des compresseurs avant la panne.', repeat('a', 64))
  returning id)
insert into ctx (k, v) select 'idea1', to_jsonb(id) from i;

-- =============================================================================
-- Serveur (service_role) : alimente et lit le cache
-- =============================================================================
set local role service_role;
select pg_temp.as_server();

select lives_ok(
  $$ with o as (
       insert into public.agent_outputs
         (challenge_id, agent, fingerprint, prompt_version, model, output)
       values (pg_temp.ctx_uuid('c1'), 'analyste', repeat('a', 64), '1.2', 'modele-test',
               '{"estimates": []}')
       returning id)
     insert into ctx (k, v) select 'out_analyste', to_jsonb(id) from o $$,
  'le serveur met en cache la sortie de l''analyste');

select lives_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, criterion_key, fingerprint, prompt_version, model, output)
     values (pg_temp.ctx_uuid('c1'), 'consultant', 'impact', repeat('b', 64), '1.2',
             'modele-test', '{"score": 3, "summary": "Gain réel."}') $$,
  'le serveur met en cache la sortie d''un consultant avec son critère');

select lives_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output, citations, usage)
     values (pg_temp.ctx_uuid('c1'), 'associe', repeat('c', 64), '1.2', 'modele-test',
             '{"recommendation": "retenir"}',
             '[{"title": "Source", "url": "https://exemple.test/a"}]',
             '{"input_tokens": 1200, "output_tokens": 300}') $$,
  'le serveur met en cache la sortie de l''associé avec citations et consommation');

select is(
  (select row(citations, usage, criterion_key)::text from public.agent_outputs
   where id = pg_temp.ctx_uuid('out_analyste')),
  row('[]'::jsonb, '{}'::jsonb, null::text)::text,
  'par défaut : aucune citation, consommation vide, pas de critère');

select throws_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output)
     values (pg_temp.ctx_uuid('c1'), 'analyste', repeat('a', 64), '1.2', 'modele-test',
             '{"estimates": ["autre"]}') $$,
  '23505', null, 'une même empreinte n''est stockée qu''une fois par challenge');

select lives_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output)
     values (pg_temp.ctx_uuid('c1'), 'analyste', repeat('a', 64), '1.2', 'modele-test',
             '{"estimates": ["autre"]}')
     on conflict (challenge_id, fingerprint) do nothing $$,
  'l''écriture « on conflict do nothing » d''une empreinte existante réussit sans effet');

select is(
  (select output from public.agent_outputs where id = pg_temp.ctx_uuid('out_analyste')),
  '{"estimates": []}'::jsonb,
  'l''entrée existante n''est pas remplacée');

select lives_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output)
     values (pg_temp.ctx_uuid('c2'), 'analyste', repeat('a', 64), '1.2', 'modele-test',
             '{"estimates": []}') $$,
  'la même empreinte est stockée séparément dans un autre challenge');

select is(
  (select count(*)::int from public.agent_outputs
   where challenge_id = pg_temp.ctx_uuid('c1') and fingerprint = repeat('a', 64)),
  1, 'le serveur retrouve l''entrée par (challenge, empreinte)');

select throws_ok(
  $$ update public.agent_outputs set output = '{"score": 5}'
     where id = pg_temp.ctx_uuid('out_analyste') $$,
  '42501', null, 'le serveur ne peut pas modifier une sortie en cache');

select throws_ok(
  $$ delete from public.agent_outputs where id = pg_temp.ctx_uuid('out_analyste') $$,
  '42501', null, 'le serveur ne peut pas supprimer une sortie en cache');

-- Contraintes ---------------------------------------------------------------
select throws_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output)
     values (pg_temp.ctx_uuid('c1'), 'juge', repeat('d', 64), '1.2', 'modele-test', '{}') $$,
  '23514', null, 'un agent inconnu est refusé');

select throws_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output)
     values (pg_temp.ctx_uuid('c1'), 'consultant', repeat('d', 64), '1.2', 'modele-test', '{}') $$,
  '23514', null, 'un consultant sans critère est refusé');

select throws_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, criterion_key, fingerprint, prompt_version, model, output)
     values (pg_temp.ctx_uuid('c1'), 'associe', 'impact', repeat('d', 64), '1.2',
             'modele-test', '{}') $$,
  '23514', null, 'une sortie de l''associé avec un critère est refusée');

select throws_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, criterion_key, fingerprint, prompt_version, model, output)
     values (pg_temp.ctx_uuid('c1'), 'consultant', 'Impact!', repeat('d', 64), '1.2',
             'modele-test', '{}') $$,
  '23514', null, 'une clé de critère mal formée est refusée');

select throws_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output)
     values (pg_temp.ctx_uuid('c1'), 'analyste', repeat('D', 64), '1.2', 'modele-test', '{}') $$,
  '23514', null, 'une empreinte en majuscules est refusée');

select throws_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output)
     values (pg_temp.ctx_uuid('c1'), 'analyste', repeat('d', 63), '1.2', 'modele-test', '{}') $$,
  '23514', null, 'une empreinte de 63 caractères est refusée');

select throws_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output)
     values (pg_temp.ctx_uuid('c1'), 'analyste', repeat('d', 64), '1.2', 'modele-test',
             '[1, 2]') $$,
  '23514', null, 'une sortie qui n''est pas un objet est refusée');

select throws_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output)
     values (pg_temp.ctx_uuid('c1'), 'analyste', repeat('d', 64), '1.2', 'modele-test',
             jsonb_build_object('texte', repeat('x', 60000))) $$,
  '23514', null, 'une sortie de plus de 60 000 octets est refusée');

select throws_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output, citations)
     values (pg_temp.ctx_uuid('c1'), 'analyste', repeat('d', 64), '1.2', 'modele-test', '{}',
             '{"url": "https://exemple.test"}') $$,
  '23514', null, 'des citations qui ne sont pas un tableau sont refusées');

select throws_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output, citations)
     values (pg_temp.ctx_uuid('c1'), 'analyste', repeat('d', 64), '1.2', 'modele-test', '{}',
             (select jsonb_agg(jsonb_build_object('url', 'https://exemple.test/' || g))
              from generate_series(1, 31) g)) $$,
  '23514', null, 'plus de 30 citations sont refusées');

select lives_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output, citations)
     values (pg_temp.ctx_uuid('c1'), 'analyste', repeat('d', 64), '1.2', 'modele-test', '{}',
             (select jsonb_agg(jsonb_build_object('url', 'https://exemple.test/' || g))
              from generate_series(1, 30) g)) $$,
  '30 citations sont acceptées');

select throws_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output, usage)
     values (pg_temp.ctx_uuid('c1'), 'analyste', repeat('e', 64), '1.2', 'modele-test', '{}',
             '[]') $$,
  '23514', null, 'une consommation qui n''est pas un objet est refusée');

select throws_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output)
     values (pg_temp.ctx_uuid('c1'), 'analyste', repeat('e', 64), '', 'modele-test', '{}') $$,
  '23514', null, 'une version de consignes vide est refusée');

select throws_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output)
     values (pg_temp.ctx_uuid('c1'), 'analyste', repeat('e', 64), '1.2', repeat('m', 121), '{}') $$,
  '23514', null, 'un nom de modèle de plus de 120 caractères est refusé');

select throws_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output)
     values ('99999999-9999-9999-9999-999999999999', 'analyste', repeat('e', 64), '1.2',
             'modele-test', '{}') $$,
  '23503', null, 'une sortie ne peut pas viser un challenge inexistant');

-- Empreinte des entrées d'une évaluation -----------------------------------
select lives_ok(
  $$ with e as (
       insert into public.evaluations
         (challenge_id, idea_id, status, prompt_version, content_hash, requested_by,
          input_fingerprint, synthesis, completed_at)
       values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'completed', '1.2',
               repeat('a', 64), '33333333-3333-3333-3333-333333333333',
               repeat('f', 64), '{"texte": "Synthèse."}', now())
       returning id)
     insert into ctx (k, v) select 'eval1', to_jsonb(id) from e $$,
  'le serveur enregistre l''empreinte des entrées d''une évaluation terminée');

select lives_ok(
  $$ insert into public.evaluations
       (challenge_id, idea_id, prompt_version, content_hash, requested_by)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), '1.1', repeat('a', 64),
             '33333333-3333-3333-3333-333333333333') $$,
  'une évaluation sans empreinte des entrées reste possible (anciennes lignes)');

select throws_ok(
  $$ insert into public.evaluations
       (challenge_id, idea_id, status, prompt_version, content_hash, requested_by,
        input_fingerprint, error_code)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'failed', '1.2',
             repeat('a', 64), '33333333-3333-3333-3333-333333333333',
             'pas-une-empreinte', 'test') $$,
  '23514', null, 'une empreinte des entrées mal formée est refusée');

select throws_ok(
  $$ update public.evaluations set input_fingerprint = repeat('F', 64)
     where id = pg_temp.ctx_uuid('eval1') $$,
  '23514', null, 'une empreinte des entrées en majuscules est refusée');

select is(
  (select id from public.evaluations
   where idea_id = pg_temp.ctx_uuid('idea1') and status = 'completed'
     and input_fingerprint = repeat('f', 64)),
  pg_temp.ctx_uuid('eval1'),
  'le serveur retrouve l''évaluation terminée par (idée, empreinte des entrées)');

select is(
  (select count(*)::int from public.agent_outputs),
  5, 'le serveur voit toutes les entrées du cache (5 au total)');

-- =============================================================================
-- Évaluateur (membre du premier challenge) : aucun accès au cache
-- =============================================================================
set local role authenticated;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');

select throws_ok(
  $$ select count(*) from public.agent_outputs $$,
  '42501', null, 'un membre du challenge ne lit pas le cache');

select throws_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output)
     values (pg_temp.ctx_uuid('c1'), 'associe', repeat('9', 64), '1.2', 'faux',
             '{"recommendation": "retenir"}') $$,
  '42501', null, 'un membre du challenge ne peut pas empoisonner le cache');

select throws_ok(
  $$ update public.agent_outputs set output = '{}'
     where id = pg_temp.ctx_uuid('out_analyste') $$,
  '42501', null, 'un membre du challenge ne peut pas modifier le cache');

select throws_ok(
  $$ delete from public.agent_outputs where id = pg_temp.ctx_uuid('out_analyste') $$,
  '42501', null, 'un membre du challenge ne peut pas vider le cache');

select is(
  (select input_fingerprint from public.evaluations where id = pg_temp.ctx_uuid('eval1')),
  repeat('f', 64), 'le membre lit l''empreinte des entrées de l''évaluation');

select throws_ok(
  $$ update public.evaluations set input_fingerprint = repeat('0', 64)
     where id = pg_temp.ctx_uuid('eval1') $$,
  '42501', null, 'un membre ne peut pas modifier l''empreinte des entrées');

-- =============================================================================
-- anon
-- =============================================================================
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok($$ select count(*) from public.agent_outputs $$, '42501', null,
  'anon ne lit pas le cache');

select throws_ok(
  $$ insert into public.agent_outputs
       (challenge_id, agent, fingerprint, prompt_version, model, output)
     values (pg_temp.ctx_uuid('c1'), 'associe', repeat('9', 64), '1.2', 'faux', '{}') $$,
  '42501', null, 'anon n''écrit pas dans le cache');

select throws_ok(
  $$ update public.agent_outputs set output = '{}' $$,
  '42501', null, 'anon ne modifie pas le cache');

select throws_ok(
  $$ delete from public.agent_outputs $$,
  '42501', null, 'anon ne vide pas le cache');

-- =============================================================================
-- Vérifications en propriétaire de la base, puis cascade
-- =============================================================================
reset role;

select is(
  (select count(*)::int from public.agent_outputs),
  5, 'aucune écriture cliente n''a abouti (toujours 5 entrées)');

set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select lives_ok(
  $$ delete from public.challenges where id = pg_temp.ctx_uuid('c1') $$,
  'l''owner supprime le challenge');
reset role;

select is(
  (select count(*)::int from public.agent_outputs where challenge_id = pg_temp.ctx_uuid('c1')),
  0, 'cascade : le cache du challenge supprimé disparaît');

select is(
  (select count(*)::int from public.agent_outputs where challenge_id = pg_temp.ctx_uuid('c2')),
  1, 'le cache de l''autre challenge reste');

select * from finish();
rollback;
