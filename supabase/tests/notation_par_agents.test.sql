-- =============================================================================
-- Tests pgTAP de la migration « notation par agents » (supabase test db).
-- Tout s'exécute dans une transaction annulée à la fin : aucune donnée ne reste.
-- Utilisateurs simulés comme le fait PostgREST : rôle authenticated (ou anon)
-- + claims JWT dans request.jwt.claims. Le serveur de notation est simulé par
-- le rôle service_role. Données entièrement fictives.
-- =============================================================================
begin;

create extension if not exists pgtap with schema extensions;

select plan(78);

-- -----------------------------------------------------------------------------
-- Préparation (rôle propriétaire de la base)
-- -----------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'proprietaire@exemple.test'),
  ('22222222-2222-2222-2222-222222222222', 'intrus@exemple.test'),
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

create function pg_temp.criterion(p_challenge text, p_key text) returns uuid
language sql stable as $$
  select id from public.criteria
  where challenge_id = pg_temp.ctx_uuid(p_challenge) and key = p_key
$$;

-- =============================================================================
-- Structure et privilèges
-- =============================================================================
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('criteria', 'evaluations', 'criterion_assessments', 'scores')
     and c.relrowsecurity),
  4, 'la RLS est activée sur les 4 nouvelles tables');

select ok(
  not has_table_privilege('authenticated', 'public.evaluations', 'insert')
  and not has_any_column_privilege('authenticated', 'public.evaluations', 'insert')
  and not has_any_column_privilege('authenticated', 'public.evaluations', 'update')
  and not has_table_privilege('authenticated', 'public.evaluations', 'delete'),
  'authenticated n''a aucun droit d''écriture sur evaluations');

select ok(
  not has_any_column_privilege('authenticated', 'public.criterion_assessments', 'insert')
  and not has_any_column_privilege('authenticated', 'public.criterion_assessments', 'update')
  and not has_table_privilege('authenticated', 'public.criterion_assessments', 'delete'),
  'authenticated n''a aucun droit d''écriture sur criterion_assessments');

select ok(
  not has_any_column_privilege('anon', 'public.criteria', 'select')
  and not has_any_column_privilege('anon', 'public.evaluations', 'select')
  and not has_any_column_privilege('anon', 'public.criterion_assessments', 'select')
  and not has_any_column_privilege('anon', 'public.scores', 'select'),
  'anon n''a aucun droit sur les nouvelles tables');

select ok(
  not has_any_column_privilege('service_role', 'public.idea_authors', 'select'),
  'service_role ne lit pas les données personnelles des auteurs');

select ok(
  not has_any_column_privilege('service_role', 'public.scores', 'insert')
  and not has_any_column_privilege('service_role', 'public.scores', 'update')
  and not has_table_privilege('service_role', 'public.scores', 'delete'),
  'service_role (code IA) ne peut pas écrire de note finale');

select ok(
  not has_function_privilege('authenticated', 'public.insert_default_criteria(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.insert_default_criteria(uuid)', 'execute'),
  'la fonction de grille par défaut n''est pas appelable par les clients');

-- =============================================================================
-- Grille par défaut à la création d'un challenge
-- =============================================================================
set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');

select lives_ok(
  $$ with c as (
       insert into public.challenges (title, client_name)
       values ('Challenge Hexavia 2026', 'Hexavia') returning id)
     insert into ctx (k, v) select 'c1', to_jsonb(id) from c $$,
  'le propriétaire crée un challenge');

select is(
  (select array_agg(key order by position) from public.criteria
   where challenge_id = pg_temp.ctx_uuid('c1')),
  array['impact', 'faisabilite', 'alignement', 'innovation'],
  'un nouveau challenge reçoit les 4 critères par défaut, dans l''ordre');

select ok(
  (select bool_and(anchors ?& array['1', '3', '5'] and weight = 1)
   from public.criteria where challenge_id = pg_temp.ctx_uuid('c1')),
  'chaque critère par défaut a ses ancres 1, 3 et 5 et un poids de 1');

select is(
  (select label from public.criteria
   where challenge_id = pg_temp.ctx_uuid('c1') and key = 'impact'),
  'Impact pour l''entreprise', 'les libellés sont en français');

select lives_ok(
  $$ with c as (
       insert into public.challenges (title, client_name)
       values ('Autre challenge', 'Autre client') returning id)
     insert into ctx (k, v) select 'c2', to_jsonb(id) from c $$,
  'le propriétaire crée un second challenge');

select lives_ok(
  $$ with i as (
       insert into public.ideas (challenge_id, external_ref, title, description, content_hash)
       values (pg_temp.ctx_uuid('c1'), 'IDEA-001', 'Capteurs de vibration',
               'Détecter l''usure des compresseurs avant la panne.', repeat('a', 64))
       returning id)
     insert into ctx (k, v) select 'idea1', to_jsonb(id) from i $$,
  'une idée est ajoutée au premier challenge');

select lives_ok(
  $$ with i as (
       insert into public.ideas (challenge_id, external_ref, title, description, content_hash)
       values (pg_temp.ctx_uuid('c2'), 'IDEA-001', 'Autre idée', 'Autre texte.', repeat('b', 64))
       returning id)
     insert into ctx (k, v) select 'idea2', to_jsonb(id) from i $$,
  'une idée est ajoutée au second challenge');

-- =============================================================================
-- Grille : modifiable par l'owner seulement
-- =============================================================================
select lives_ok(
  $$ update public.criteria set weight = 2
     where id = pg_temp.criterion('c1', 'impact') $$,
  'l''owner modifie le poids d''un critère');

select is(
  (select weight from public.criteria where id = pg_temp.criterion('c1', 'impact')),
  2.00::numeric(4,2), 'le nouveau poids est enregistré');

select throws_ok(
  $$ update public.criteria set weight = 0 where id = pg_temp.criterion('c1', 'impact') $$,
  '23514', null, 'un poids nul est refusé');

select throws_ok(
  $$ insert into public.criteria (challenge_id, key, label, description, position)
     values (pg_temp.ctx_uuid('c1'), 'Cout-Total', 'Coût', 'Coût total.', 5) $$,
  '23514', null, 'une clé de critère hors format est refusée');

select throws_ok(
  $$ update public.criteria set key = 'autre' where id = pg_temp.criterion('c1', 'impact') $$,
  '42501', null, 'la clé d''un critère n''est pas modifiable');

select lives_ok(
  $$ insert into public.challenge_members (challenge_id, user_id)
     values (pg_temp.ctx_uuid('c1'), '33333333-3333-3333-3333-333333333333') $$,
  'le propriétaire ajoute un évaluateur');

-- =============================================================================
-- Évaluateur (membre non owner)
-- =============================================================================
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');

select is(
  (select count(*)::int from public.criteria where challenge_id = pg_temp.ctx_uuid('c1')),
  4, 'l''évaluateur voit la grille du challenge');

select lives_ok(
  $$ update public.challenges
     set context = 'Groupe industriel, priorité à la décarbonation et à la sécurité.'
     where id = pg_temp.ctx_uuid('c1') $$,
  'un membre renseigne le contexte du client');

select is(
  (select context from public.challenges where id = pg_temp.ctx_uuid('c1')),
  'Groupe industriel, priorité à la décarbonation et à la sécurité.',
  'le contexte est enregistré');

select throws_ok(
  $$ update public.challenges set context = repeat('x', 8001) where id = pg_temp.ctx_uuid('c1') $$,
  '23514', null, 'un contexte de plus de 8000 caractères est refusé');

update public.criteria set weight = 5 where challenge_id = pg_temp.ctx_uuid('c1');
delete from public.criteria where challenge_id = pg_temp.ctx_uuid('c1');

select is(
  (select array_agg(weight order by position) from public.criteria
   where challenge_id = pg_temp.ctx_uuid('c1')),
  array[2, 1, 1, 1]::numeric(4,2)[],
  'un évaluateur ne peut ni modifier ni supprimer un critère');

select throws_ok(
  $$ insert into public.criteria (challenge_id, key, label, description, position)
     values (pg_temp.ctx_uuid('c1'), 'cout', 'Coût', 'Coût total.', 5) $$,
  '42501', null, 'un évaluateur ne peut pas ajouter de critère');

select throws_ok(
  $$ insert into public.evaluations (challenge_id, idea_id, prompt_version, content_hash, requested_by)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'v1', repeat('a', 64),
             '33333333-3333-3333-3333-333333333333') $$,
  '42501', null, 'un utilisateur ne peut pas créer d''évaluation IA');

-- =============================================================================
-- Serveur de notation (service_role)
-- =============================================================================
set local role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);

select is(
  (select context from public.challenges where id = pg_temp.ctx_uuid('c1')),
  'Groupe industriel, priorité à la décarbonation et à la sécurité.',
  'le serveur lit le contexte du challenge');

select is(
  (select count(*)::int from public.challenge_members
   where challenge_id = pg_temp.ctx_uuid('c1')
     and user_id = '33333333-3333-3333-3333-333333333333'),
  1, 'le serveur peut vérifier qu''un appelant est membre du challenge');

select throws_ok(
  $$ select count(*) from public.idea_authors $$,
  '42501', null, 'le serveur ne lit pas les auteurs (données personnelles)');

select lives_ok(
  $$ with e as (
       insert into public.evaluations (challenge_id, idea_id, prompt_version, content_hash,
                                       models, requested_by)
       values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'v1', repeat('a', 64),
               '{"analyste": "modele-test", "associe": "modele-test"}',
               '33333333-3333-3333-3333-333333333333')
       returning id)
     insert into ctx (k, v) select 'eval1', to_jsonb(id) from e $$,
  'le serveur crée une évaluation (en cours)');

select throws_ok(
  $$ insert into public.evaluations (challenge_id, idea_id, prompt_version, content_hash, requested_by)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea1'), 'v1', repeat('a', 64),
             '33333333-3333-3333-3333-333333333333') $$,
  '23505', null, 'un seul passage en cours par idée');

select throws_ok(
  $$ insert into public.evaluations (challenge_id, idea_id, prompt_version, content_hash, requested_by)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('idea2'), 'v1', repeat('b', 64),
             '33333333-3333-3333-3333-333333333333') $$,
  '23503', null, 'une évaluation ne peut pas viser l''idée d''un autre challenge');

select lives_ok(
  $$ insert into public.criterion_assessments
       (challenge_id, evaluation_id, idea_id, criterion_id, ai_score, summary, details, sources, model)
     select pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('eval1'), pg_temp.ctx_uuid('idea1'), c.id,
            3, 'Évaluation argumentée du critère.',
            '{"sous_criteres": [], "pour": [], "contre": [], "hypotheses": [], "confiance": "moyenne"}',
            '[{"title": "Étude fictive", "url": "https://exemple.test/etude", "excerpt": "Extrait."}]',
            'modele-test'
     from public.criteria c where c.challenge_id = pg_temp.ctx_uuid('c1') $$,
  'le serveur enregistre l''évaluation des 4 critères');

select is(
  (select count(*)::int from public.criterion_assessments
   where evaluation_id = pg_temp.ctx_uuid('eval1')),
  4, '4 évaluations de critère enregistrées');

select throws_ok(
  $$ insert into public.criterion_assessments
       (challenge_id, evaluation_id, idea_id, criterion_id, ai_score, summary, details, model)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('eval1'), pg_temp.ctx_uuid('idea1'),
             pg_temp.criterion('c1', 'impact'), 6, 'Hors bornes.', '{}', 'modele-test') $$,
  '23514', null, 'une note IA de 6 est refusée');

select throws_ok(
  $$ update public.criterion_assessments set ai_score = 0
     where evaluation_id = pg_temp.ctx_uuid('eval1') $$,
  '23514', null, 'une note IA de 0 est refusée');

select throws_ok(
  $$ update public.criterion_assessments
     set sources = (select jsonb_agg(jsonb_build_object('title', 't', 'url', 'https://exemple.test', 'excerpt', 'e'))
                    from generate_series(1, 21))
     where evaluation_id = pg_temp.ctx_uuid('eval1') $$,
  '23514', null, 'plus de 20 sources sont refusées');

select throws_ok(
  $$ update public.criterion_assessments set sources = '{"title": "pas un tableau"}'
     where evaluation_id = pg_temp.ctx_uuid('eval1') $$,
  '23514', null, 'des sources qui ne sont pas un tableau sont refusées');

select throws_ok(
  $$ insert into public.criterion_assessments
       (challenge_id, evaluation_id, idea_id, criterion_id, ai_score, summary, details, model)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('eval1'), pg_temp.ctx_uuid('idea1'),
             pg_temp.criterion('c2', 'faisabilite'), 3, 'Mauvaise grille.', '{}', 'modele-test') $$,
  '23503', null, 'un critère d''un autre challenge est refusé (FK composite)');

select throws_ok(
  $$ update public.evaluations set status = 'completed', completed_at = now()
     where id = pg_temp.ctx_uuid('eval1') $$,
  '23514', null, 'une évaluation terminée sans synthèse est refusée');

select throws_ok(
  $$ update public.evaluations set status = 'failed', completed_at = now()
     where id = pg_temp.ctx_uuid('eval1') $$,
  '23514', null, 'un échec sans code d''erreur est refusé');

select lives_ok(
  $$ update public.evaluations
     set status = 'completed', completed_at = now(),
         synthesis = '{"texte": "Synthèse fictive.", "points_forts": [], "points_faibles": [], "incoherences": []}',
         recommendation = 'a_discuter', web_sources_count = 4,
         usage = '{"input_tokens": 1000, "output_tokens": 500}'
     where id = pg_temp.ctx_uuid('eval1') $$,
  'le serveur termine l''évaluation avec sa synthèse');

select throws_ok(
  $$ insert into public.scores (idea_id, criterion_id, challenge_id, final_score, validated_by)
     values (pg_temp.ctx_uuid('idea1'), pg_temp.criterion('c1', 'impact'), pg_temp.ctx_uuid('c1'), 5,
             '33333333-3333-3333-3333-333333333333') $$,
  '42501', null, 'le serveur (code IA) ne peut pas écrire de note finale');

-- =============================================================================
-- Retour à l'évaluateur : lecture seule des résultats IA, validation humaine
-- =============================================================================
set local role authenticated;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');

select is(
  (select row(status, recommendation, web_sources_count)::text from public.evaluations
   where id = pg_temp.ctx_uuid('eval1')),
  row('completed', 'a_discuter', 4)::text, 'l''évaluateur lit l''évaluation terminée');

select is(
  (select count(*)::int from public.criterion_assessments where idea_id = pg_temp.ctx_uuid('idea1')),
  4, 'l''évaluateur lit les 4 évaluations de critère');

select throws_ok(
  $$ update public.evaluations set recommendation = 'retenir' where id = pg_temp.ctx_uuid('eval1') $$,
  '42501', null, 'un utilisateur ne peut pas modifier une évaluation IA');

select throws_ok(
  $$ delete from public.evaluations where id = pg_temp.ctx_uuid('eval1') $$,
  '42501', null, 'un utilisateur ne peut pas supprimer une évaluation IA');

select throws_ok(
  $$ update public.criterion_assessments set ai_score = 5 where idea_id = pg_temp.ctx_uuid('idea1') $$,
  '42501', null, 'un utilisateur ne peut pas modifier une note IA');

select throws_ok(
  $$ insert into public.criterion_assessments
       (challenge_id, evaluation_id, idea_id, criterion_id, ai_score, summary, details, model)
     values (pg_temp.ctx_uuid('c1'), pg_temp.ctx_uuid('eval1'), pg_temp.ctx_uuid('idea1'),
             pg_temp.criterion('c1', 'impact'), 5, 'Fabriquée.', '{}', 'faux') $$,
  '42501', null, 'un utilisateur ne peut pas fabriquer une évaluation de critère');

select lives_ok(
  $$ insert into public.scores (idea_id, criterion_id, challenge_id, final_score, final_comment,
                                based_on_assessment_id, validated_by)
     select pg_temp.ctx_uuid('idea1'), a.criterion_id, pg_temp.ctx_uuid('c1'), 4, 'Validé.',
            a.id, '22222222-2222-2222-2222-222222222222'
     from public.criterion_assessments a
     where a.evaluation_id = pg_temp.ctx_uuid('eval1')
       and a.criterion_id = pg_temp.criterion('c1', 'impact') $$,
  'un membre valide une note en tentant de l''attribuer à quelqu''un d''autre');

select is(
  (select validated_by from public.scores
   where idea_id = pg_temp.ctx_uuid('idea1') and criterion_id = pg_temp.criterion('c1', 'impact')),
  '33333333-3333-3333-3333-333333333333'::uuid,
  'validated_by vaut l''utilisateur courant malgré la tentative');

select lives_ok(
  $$ insert into public.scores (idea_id, criterion_id, challenge_id, final_score)
     values (pg_temp.ctx_uuid('idea1'), pg_temp.criterion('c1', 'faisabilite'),
             pg_temp.ctx_uuid('c1'), 3) $$,
  'un membre valide une note sans évaluation IA de référence');

select throws_ok(
  $$ insert into public.scores (idea_id, criterion_id, challenge_id, final_score)
     values (pg_temp.ctx_uuid('idea1'), pg_temp.criterion('c1', 'alignement'),
             pg_temp.ctx_uuid('c1'), 6) $$,
  '23514', null, 'une note finale de 6 est refusée');

select throws_ok(
  $$ insert into public.scores (idea_id, criterion_id, challenge_id, final_score, based_on_assessment_id)
     select pg_temp.ctx_uuid('idea1'), pg_temp.criterion('c1', 'alignement'), pg_temp.ctx_uuid('c1'), 3, a.id
     from public.criterion_assessments a
     where a.evaluation_id = pg_temp.ctx_uuid('eval1')
       and a.criterion_id = pg_temp.criterion('c1', 'impact') $$,
  '23503', null, 'une note ne peut pas s''appuyer sur l''évaluation IA d''un autre critère');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');

select lives_ok(
  $$ update public.scores set final_score = 5, validated_by = '33333333-3333-3333-3333-333333333333'
     where idea_id = pg_temp.ctx_uuid('idea1') and criterion_id = pg_temp.criterion('c1', 'impact') $$,
  'l''owner corrige la note en tentant de garder la signature de l''évaluateur');

select is(
  (select row(final_score, validated_by)::text from public.scores
   where idea_id = pg_temp.ctx_uuid('idea1') and criterion_id = pg_temp.criterion('c1', 'impact')),
  row(5, '11111111-1111-1111-1111-111111111111'::uuid)::text,
  'la correction est signée par celui qui la fait (trigger)');

select lives_ok(
  $$ delete from public.scores
     where idea_id = pg_temp.ctx_uuid('idea1') and criterion_id = pg_temp.criterion('c1', 'faisabilite') $$,
  'un membre retire une validation');

select is(
  (select count(*)::int from public.scores where idea_id = pg_temp.ctx_uuid('idea1')),
  1, 'la note retirée a disparu');

-- =============================================================================
-- Non-membre (intrus)
-- =============================================================================
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');

select is((select count(*)::int from public.criteria), 0, 'non-membre : aucun critère visible');
select is((select count(*)::int from public.evaluations), 0, 'non-membre : aucune évaluation visible');
select is((select count(*)::int from public.criterion_assessments), 0,
  'non-membre : aucune évaluation de critère visible');
select is((select count(*)::int from public.scores), 0, 'non-membre : aucune note visible');

select throws_ok(
  $$ insert into public.scores (idea_id, criterion_id, challenge_id, final_score)
     values (pg_temp.ctx_uuid('idea1'), pg_temp.criterion('c1', 'alignement'),
             pg_temp.ctx_uuid('c1'), 1) $$,
  '42501', null, 'un non-membre ne peut pas valider de note');

update public.challenges set context = 'Piraté' where id = pg_temp.ctx_uuid('c1');
update public.scores set final_score = 1;
delete from public.scores;

-- =============================================================================
-- Sans identité : authenticated sans claims, puis anon
-- =============================================================================
select set_config('request.jwt.claims', '', true);
select is((select count(*)::int from public.scores), 0, 'sans utilisateur courant : aucune note visible');

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok($$ select count(*) from public.criteria $$, '42501', null, 'anon ne lit pas les critères');
select throws_ok($$ select count(*) from public.evaluations $$, '42501', null, 'anon ne lit pas les évaluations');
select throws_ok($$ select count(*) from public.criterion_assessments $$, '42501', null,
  'anon ne lit pas les évaluations de critère');
select throws_ok($$ select count(*) from public.scores $$, '42501', null, 'anon ne lit pas les notes');

-- =============================================================================
-- Vérifications en propriétaire de la base
-- =============================================================================
reset role;

select is(
  (select row(s.final_score, c.context)::text
   from public.scores s join public.challenges c on c.id = s.challenge_id
   where s.idea_id = pg_temp.ctx_uuid('idea1')),
  row(5, 'Groupe industriel, priorité à la décarbonation et à la sécurité.')::text,
  'les écritures d''un non-membre n''ont rien modifié');

-- La disparition de l'évaluation IA de référence ne supprime pas la note et
-- n'en change pas la signature, même avec un autre utilisateur courant.
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
delete from public.criterion_assessments
where evaluation_id = pg_temp.ctx_uuid('eval1')
  and criterion_id = pg_temp.criterion('c1', 'impact');

select is(
  (select row(final_score, based_on_assessment_id, validated_by)::text from public.scores
   where idea_id = pg_temp.ctx_uuid('idea1') and criterion_id = pg_temp.criterion('c1', 'impact')),
  row(5, null::uuid, '11111111-1111-1111-1111-111111111111'::uuid)::text,
  'la note survit à son évaluation IA de référence, signature inchangée');

select set_config('request.jwt.claims', '', true);

-- =============================================================================
-- Rattrapage de la grille par défaut (bloc § 5 de la migration, rejoué)
-- =============================================================================
-- Challenge créé « avant la migration » : trigger désactivé le temps de
-- l'insertion (annulé avec la transaction).
alter table public.challenges disable trigger challenges_add_default_criteria;
insert into public.challenges (id, title, client_name, created_by)
values ('cccccccc-0000-0000-0000-000000000003', 'Ancien challenge', 'Ancien client',
        '11111111-1111-1111-1111-111111111111');
alter table public.challenges enable trigger challenges_add_default_criteria;

select is(
  (select count(*)::int from public.criteria
   where challenge_id = 'cccccccc-0000-0000-0000-000000000003'),
  0, 'un challenge antérieur à la migration n''a pas de critère');

-- Grille personnalisée du second challenge : un seul critère.
delete from public.criteria
where challenge_id = pg_temp.ctx_uuid('c2') and key <> 'impact';

-- Bloc de rattrapage, à l'identique de la migration (2 fois : idempotent).
select public.insert_default_criteria(c.id)
from public.challenges as c
where not exists (
  select 1 from public.criteria as cr where cr.challenge_id = c.id
);
select public.insert_default_criteria(c.id)
from public.challenges as c
where not exists (
  select 1 from public.criteria as cr where cr.challenge_id = c.id
);

select is(
  (select count(*)::int from public.criteria
   where challenge_id = 'cccccccc-0000-0000-0000-000000000003'),
  4, 'le rattrapage donne la grille par défaut au challenge existant (une seule fois)');

select is(
  (select count(*)::int from public.criteria where challenge_id = pg_temp.ctx_uuid('c2')),
  1, 'le rattrapage ne complète pas une grille déjà personnalisée');

-- =============================================================================
-- Suppression du challenge par son owner : cascade
-- =============================================================================
set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
delete from public.challenges where id = pg_temp.ctx_uuid('c1');
reset role;

select is((select count(*)::int from public.criteria where challenge_id = pg_temp.ctx_uuid('c1')),
  0, 'cascade : les critères du challenge sont supprimés');
select is((select count(*)::int from public.evaluations where challenge_id = pg_temp.ctx_uuid('c1')),
  0, 'cascade : les évaluations sont supprimées');
select is((select count(*)::int from public.criterion_assessments where challenge_id = pg_temp.ctx_uuid('c1')),
  0, 'cascade : les évaluations de critère sont supprimées');
select is((select count(*)::int from public.scores where challenge_id = pg_temp.ctx_uuid('c1')),
  0, 'cascade : les notes sont supprimées');

select * from finish();
rollback;
