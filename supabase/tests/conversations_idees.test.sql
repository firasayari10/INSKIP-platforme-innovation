-- =============================================================================
-- Tests pgTAP de la migration « conversations sur les idées » (supabase test db).
-- Tout s'exécute dans une transaction annulée à la fin : aucune donnée ne reste.
-- Utilisateurs simulés comme le fait PostgREST : rôle authenticated (ou anon)
-- + claims JWT dans request.jwt.claims. Le serveur de conversation est simulé
-- par le rôle service_role. Données entièrement fictives.
-- =============================================================================
begin;

create extension if not exists pgtap with schema extensions;

select plan(59);

-- -----------------------------------------------------------------------------
-- Préparation (rôle propriétaire de la base)
-- -----------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'proprietaire@exemple.test'),
  ('22222222-2222-2222-2222-222222222222', 'intrus@exemple.test'),
  ('33333333-3333-3333-3333-333333333333', 'evaluateur@exemple.test'),
  ('44444444-4444-4444-4444-444444444444', 'depart@exemple.test');

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
  (select relrowsecurity from pg_class where oid = 'public.idea_chat_messages'::regclass),
  'la RLS est activée sur idea_chat_messages');

select ok(
  has_table_privilege('authenticated', 'public.idea_chat_messages', 'select')
  and not has_any_column_privilege('authenticated', 'public.idea_chat_messages', 'insert')
  and not has_any_column_privilege('authenticated', 'public.idea_chat_messages', 'update')
  and not has_table_privilege('authenticated', 'public.idea_chat_messages', 'delete'),
  'authenticated lit les messages mais n''a aucun droit d''écriture');

select ok(
  not has_any_column_privilege('anon', 'public.idea_chat_messages', 'select')
  and not has_any_column_privilege('anon', 'public.idea_chat_messages', 'insert')
  and not has_any_column_privilege('anon', 'public.idea_chat_messages', 'update')
  and not has_table_privilege('anon', 'public.idea_chat_messages', 'delete'),
  'anon n''a aucun droit sur idea_chat_messages');

select ok(
  has_table_privilege('service_role', 'public.idea_chat_messages', 'select')
  and has_table_privilege('service_role', 'public.idea_chat_messages', 'insert')
  and has_column_privilege('service_role', 'public.idea_chat_messages', 'used_for_evaluation_id', 'update')
  and not has_column_privilege('service_role', 'public.idea_chat_messages', 'content', 'update')
  and not has_column_privilege('service_role', 'public.idea_chat_messages', 'role', 'update')
  and not has_column_privilege('service_role', 'public.idea_chat_messages', 'author_id', 'update')
  and not has_table_privilege('service_role', 'public.idea_chat_messages', 'delete'),
  'service_role lit, insère et ne modifie que used_for_evaluation_id, sans suppression');

select ok(
  has_column_privilege('authenticated', 'public.evaluations', 'evaluator_notes', 'select')
  and not has_column_privilege('authenticated', 'public.evaluations', 'evaluator_notes', 'insert')
  and not has_column_privilege('authenticated', 'public.evaluations', 'evaluator_notes', 'update')
  and has_column_privilege('service_role', 'public.evaluations', 'evaluator_notes', 'insert'),
  'evaluator_notes : lue par authenticated, écrite par service_role seulement');

select ok(
  not has_function_privilege('authenticated', 'public.check_chat_message_author()', 'execute')
  and not has_function_privilege('service_role', 'public.check_chat_message_author()', 'execute')
  and not has_function_privilege('anon', 'public.check_chat_message_author()', 'execute'),
  'la fonction de trigger n''est pas appelable par les clients');

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

with i as (
  insert into public.ideas (challenge_id, external_ref, title, description, content_hash)
  values (pg_temp.ctx_uuid('c1'), 'IDEA-002', 'Maintenance prédictive',
          'Anticiper les pannes des lignes de production.', repeat('b', 64))
  returning id)
insert into ctx (k, v) select 'idea1b', to_jsonb(id) from i;

with i as (
  insert into public.ideas (challenge_id, external_ref, title, description, content_hash)
  values (pg_temp.ctx_uuid('c2'), 'IDEA-001', 'Autre idée', 'Autre texte.', repeat('c', 64))
  returning id)
insert into ctx (k, v) select 'idea2', to_jsonb(id) from i;

-- =============================================================================
-- Serveur (service_role) : écrit les messages et les évaluations
-- =============================================================================
set local role service_role;
select pg_temp.as_server();

with e as (
  insert into public.evaluations (challenge_id, idea_id, prompt_version, content_hash, requested_by)
  values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'v1', repeat('a', 64),
          '33333333-3333-3333-3333-333333333333')
  returning id)
insert into ctx (k, v) select 'eval1', to_jsonb(id) from e;

select lives_ok(
  $$ with e as (
       insert into public.evaluations (challenge_id, idea_id, prompt_version, content_hash,
                                       requested_by, evaluator_notes)
       values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1b'), 'v1', repeat('b', 64),
               '33333333-3333-3333-3333-333333333333',
               'Le client a déjà budgété 50 000 € pour ce type de projet.')
       returning id)
     insert into ctx (k, v) select 'evalB', to_jsonb(id) from e $$,
  'le serveur crée une réévaluation avec les informations de l''évaluateur');

select throws_ok(
  $$ update public.evaluations set evaluator_notes = repeat('x', 8001)
     where id = pg_temp.ctx_uuid('eval1') $$,
  '23514', null, 'des informations de l''évaluateur de plus de 8000 caractères sont refusées');

select lives_ok(
  $$ update public.evaluations set evaluator_notes = repeat('x', 8000)
     where id = pg_temp.ctx_uuid('eval1') $$,
  'des informations de l''évaluateur de 8000 caractères sont acceptées');

select lives_ok(
  $$ with m as (
       insert into public.idea_chat_messages
         (challenge_id, idea_id, role, author_id, content, referenced_refs)
       values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'user',
               '33333333-3333-3333-3333-333333333333',
               'Pourquoi cette note de faisabilité ? Compare avec @IDEA-002.',
               array['IDEA-002'])
       returning id)
     insert into ctx (k, v) select 'msg_user', to_jsonb(id) from m $$,
  'le serveur enregistre le message de l''évaluateur');

select lives_ok(
  $$ with m as (
       insert into public.idea_chat_messages
         (challenge_id, idea_id, role, content, referenced_refs, model)
       values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'assistant',
               'La faisabilité est notée 3 car le budget n''est pas chiffré.',
               array['IDEA-002'], 'modele-test')
       returning id)
     insert into ctx (k, v) select 'msg_assistant', to_jsonb(id) from m $$,
  'le serveur enregistre la réponse de l''assistant');

select is(
  (select row(referenced_refs, used_for_evaluation_id, author_id is not null)::text
   from public.idea_chat_messages where id = pg_temp.ctx_uuid('msg_user')),
  row(array['IDEA-002'], null::uuid, true)::text,
  'le message utilisateur est enregistré avec ses références et son auteur');

-- Contraintes ---------------------------------------------------------------
select throws_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, content, model)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'system', 'Consigne.', 'modele-test') $$,
  '23514', null, 'un rôle inconnu est refusé');

select throws_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, author_id, content)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'user',
             '33333333-3333-3333-3333-333333333333', '') $$,
  '23514', null, 'un message vide est refusé');

select throws_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, author_id, content)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'user',
             '33333333-3333-3333-3333-333333333333', repeat('x', 8001)) $$,
  '23514', null, 'un message de plus de 8000 caractères est refusé');

select lives_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, author_id, content)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'user',
             '33333333-3333-3333-3333-333333333333', repeat('x', 8000)) $$,
  'un message de 8000 caractères est accepté');

select throws_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, author_id, content, referenced_refs)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'user',
             '33333333-3333-3333-3333-333333333333', 'Trop de références.',
             (select array_agg('IDEA-' || lpad(g::text, 3, '0')) from generate_series(1, 11) g)) $$,
  '23514', null, 'plus de 10 références sont refusées');

select lives_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, author_id, content, referenced_refs)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'user',
             '33333333-3333-3333-3333-333333333333', 'Dix références.',
             (select array_agg('IDEA-' || lpad(g::text, 3, '0')) from generate_series(1, 10) g)) $$,
  '10 références sont acceptées');

select throws_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, author_id, content, referenced_refs)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'user',
             '33333333-3333-3333-3333-333333333333', 'Référence nulle.', array['IDEA-002', null]) $$,
  '23514', null, 'une référence nulle est refusée');

select throws_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, author_id, content, referenced_refs)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'user',
             '33333333-3333-3333-3333-333333333333', 'Références trop longues.',
             array[repeat('x', 400), repeat('y', 400)]) $$,
  '23514', null, 'des références de plus de 640 caractères au total sont refusées');

select throws_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, content)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'user', 'Sans auteur.') $$,
  '23514', null, 'un message utilisateur sans auteur est refusé à la création');

select throws_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, author_id, content, model)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'assistant',
             '33333333-3333-3333-3333-333333333333', 'Réponse signée.', 'modele-test') $$,
  '23514', null, 'une réponse de l''assistant ne peut pas avoir d''auteur');

select throws_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, content)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'assistant', 'Sans modèle.') $$,
  '23514', null, 'une réponse de l''assistant sans modèle est refusée');

select throws_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, author_id, content, model)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'user',
             '33333333-3333-3333-3333-333333333333', 'Avec modèle.', 'modele-test') $$,
  '23514', null, 'un message utilisateur ne porte pas de modèle');

select throws_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, content, model)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'assistant', 'Modèle long.',
             repeat('m', 121)) $$,
  '23514', null, 'un nom de modèle de plus de 120 caractères est refusé');

select throws_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, author_id, content)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea2'), 'user',
             '33333333-3333-3333-3333-333333333333', 'Mauvais challenge.') $$,
  '23503', null, 'un message ne peut pas viser l''idée d''un autre challenge (FK composite)');

select throws_ok(
  $$ insert into public.idea_chat_messages
       (challenge_id, idea_id, role, author_id, content, used_for_evaluation_id)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'user',
             '33333333-3333-3333-3333-333333333333', 'Mauvaise évaluation.',
             pg_temp.ctx_uuid('evalB')) $$,
  '23503', null, 'un message ne peut pas être créé rattaché à l''évaluation d''une autre idée');

-- Rattachement à une réévaluation ------------------------------------------
select throws_ok(
  $$ update public.idea_chat_messages set used_for_evaluation_id = pg_temp.ctx_uuid('evalB')
     where id = pg_temp.ctx_uuid('msg_user') $$,
  '23503', null, 'un message ne peut pas être rattaché à l''évaluation d''une autre idée');

select lives_ok(
  $$ update public.idea_chat_messages set used_for_evaluation_id = pg_temp.ctx_uuid('eval1')
     where id = pg_temp.ctx_uuid('msg_user') $$,
  'le serveur rattache le message à la réévaluation de la même idée');

select throws_ok(
  $$ update public.idea_chat_messages set content = 'Réécrit.'
     where id = pg_temp.ctx_uuid('msg_assistant') $$,
  '42501', null, 'le serveur ne peut pas réécrire un message');

select throws_ok(
  $$ delete from public.idea_chat_messages where id = pg_temp.ctx_uuid('msg_assistant') $$,
  '42501', null, 'le serveur ne peut pas supprimer un message');

select throws_ok(
  $$ select count(*) from public.idea_authors $$,
  '42501', null, 'le serveur ne lit toujours pas les auteurs (données personnelles)');

-- Messages sur la seconde idée du challenge, rattachés à sa réévaluation, et
-- message d'un utilisateur dont le compte sera supprimé.
insert into public.idea_chat_messages
  (challenge_id, idea_id, role, author_id, content, used_for_evaluation_id)
values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1b'), 'user',
        '33333333-3333-3333-3333-333333333333', 'Le budget est déjà voté.',
        pg_temp.ctx_uuid('evalB'));

with m as (
  insert into public.idea_chat_messages (challenge_id, idea_id, role, author_id, content)
  values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1b'), 'user',
          '44444444-4444-4444-4444-444444444444', 'Message d''un compte supprimé ensuite.')
  returning id)
insert into ctx (k, v) select 'msg_depart', to_jsonb(id) from m;

-- Message sur l'idée de l'autre challenge (pour l'isolation).
insert into public.idea_chat_messages (challenge_id, idea_id, role, content, model)
values (pg_temp.ctx_uuid('c2'), pg_temp.ctx_uuid('idea2'), 'assistant',
        'Réponse dans l''autre challenge.', 'modele-test');

select is(
  (select count(*)::int from public.idea_chat_messages),
  7, 'le serveur voit tous les messages (7 au total)');

-- =============================================================================
-- Évaluateur (membre du premier challenge) : lecture seule
-- =============================================================================
set local role authenticated;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');

select is(
  (select count(*)::int from public.idea_chat_messages where idea_id = pg_temp.ctx_uuid('idea1')),
  4, 'le membre lit les messages de l''idée');

select is(
  (select array_agg(role order by created_at, role desc) from public.idea_chat_messages
   where id in (pg_temp.ctx_uuid('msg_user'), pg_temp.ctx_uuid('msg_assistant'))),
  array['user', 'assistant'], 'le fil se lit dans l''ordre de création');

select is(
  (select count(*)::int from public.idea_chat_messages),
  6, 'le membre ne voit que les messages de son challenge (6 sur 7)');

select is(
  (select used_for_evaluation_id from public.idea_chat_messages where id = pg_temp.ctx_uuid('msg_user')),
  pg_temp.ctx_uuid('eval1'), 'le membre voit à quelle réévaluation le message a servi');

select is(
  (select evaluator_notes from public.evaluations where id = pg_temp.ctx_uuid('evalB')),
  'Le client a déjà budgété 50 000 € pour ce type de projet.',
  'le membre lit les informations transmises aux agents');

select throws_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, author_id, content)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'user',
             '33333333-3333-3333-3333-333333333333', 'Écrit depuis le navigateur.') $$,
  '42501', null, 'un utilisateur ne peut pas écrire de message lui-même');

select throws_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, content, model)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'assistant',
             'Fausse réponse de l''IA.', 'faux') $$,
  '42501', null, 'un utilisateur ne peut pas fabriquer une réponse de l''assistant');

select throws_ok(
  $$ update public.idea_chat_messages set content = 'Réécrit.'
     where id = pg_temp.ctx_uuid('msg_assistant') $$,
  '42501', null, 'un utilisateur ne peut pas modifier un message');

select throws_ok(
  $$ update public.idea_chat_messages set used_for_evaluation_id = null
     where id = pg_temp.ctx_uuid('msg_user') $$,
  '42501', null, 'un utilisateur ne peut pas détacher un message de sa réévaluation');

select throws_ok(
  $$ delete from public.idea_chat_messages where id = pg_temp.ctx_uuid('msg_user') $$,
  '42501', null, 'un utilisateur ne peut pas supprimer un message');

select throws_ok(
  $$ update public.evaluations set evaluator_notes = 'Modifié.' where id = pg_temp.ctx_uuid('evalB') $$,
  '42501', null, 'un utilisateur ne peut pas modifier les informations transmises aux agents');

-- =============================================================================
-- Non-membre (intrus), sans identité, anon
-- =============================================================================
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');

select is((select count(*)::int from public.idea_chat_messages), 0,
  'non-membre : aucun message visible');

select throws_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, author_id, content)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'user',
             '22222222-2222-2222-2222-222222222222', 'Intrusion.') $$,
  '42501', null, 'un non-membre ne peut pas écrire de message');

select set_config('request.jwt.claims', '', true);
select is((select count(*)::int from public.idea_chat_messages), 0,
  'sans utilisateur courant : aucun message visible');

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok($$ select count(*) from public.idea_chat_messages $$, '42501', null,
  'anon ne lit pas les messages');
select throws_ok(
  $$ insert into public.idea_chat_messages (challenge_id, idea_id, role, content, model)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'assistant', 'Anonyme.', 'faux') $$,
  '42501', null, 'anon n''écrit pas de message');

-- =============================================================================
-- Vérifications en propriétaire de la base
-- =============================================================================
reset role;

select is(
  (select count(*)::int from public.idea_chat_messages),
  7, 'aucune écriture cliente n''a abouti (toujours 7 messages)');

-- Suppression d'un compte : le message reste, sans auteur (pas d'erreur du
-- check permanent « assistant ⇒ pas d'auteur »).
select lives_ok(
  $$ delete from auth.users where id = '44444444-4444-4444-4444-444444444444' $$,
  'la suppression d''un compte n''est pas bloquée par ses messages');

select is(
  (select row(role, author_id)::text from public.idea_chat_messages
   where id = pg_temp.ctx_uuid('msg_depart')),
  row('user', null::uuid)::text,
  'le message d''un compte supprimé est conservé, sans auteur');

-- Suppression d'une évaluation : le message reste, seule la référence tombe.
delete from public.evaluations where id = pg_temp.ctx_uuid('eval1');

select is(
  (select row(used_for_evaluation_id, challenge_id, idea_id)::text from public.idea_chat_messages
   where id = pg_temp.ctx_uuid('msg_user')),
  row(null::uuid, pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'))::text,
  'le message survit à son évaluation, seule la référence passe à NULL');

-- Suppression de l'idée : cascade.
delete from public.ideas where id = pg_temp.ctx_uuid('idea1');

select is(
  (select count(*)::int from public.idea_chat_messages where idea_id = pg_temp.ctx_uuid('idea1')),
  0, 'cascade : les messages de l''idée supprimée disparaissent');

select is(
  (select count(*)::int from public.idea_chat_messages where idea_id = pg_temp.ctx_uuid('idea1b')),
  2, 'les messages des autres idées restent');

-- =============================================================================
-- Suppression du challenge par son owner : cascade (idées, évaluations et
-- messages rattachés à ces évaluations, dans la même instruction)
-- =============================================================================
set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select lives_ok(
  $$ delete from public.challenges where id = pg_temp.ctx_uuid('c1') $$,
  'l''owner supprime le challenge');
reset role;

select is(
  (select count(*)::int from public.idea_chat_messages where challenge_id = pg_temp.ctx_uuid('c1')),
  0, 'cascade : les messages du challenge sont supprimés');

select is(
  (select count(*)::int from public.evaluations where challenge_id = pg_temp.ctx_uuid('c1')),
  0, 'cascade : les évaluations du challenge sont supprimées');

select is(
  (select count(*)::int from public.idea_chat_messages where challenge_id = pg_temp.ctx_uuid('c2')),
  1, 'les messages de l''autre challenge restent');

select * from finish();
rollback;
