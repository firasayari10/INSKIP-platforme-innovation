-- =============================================================================
-- Tests pgTAP de la migration « import des idées » (supabase test db).
-- Tout s'exécute dans une transaction annulée à la fin : aucune donnée ne reste.
-- Les utilisateurs sont simulés comme le fait PostgREST : rôle authenticated
-- (ou anon) + claims JWT dans request.jwt.claims (lus par auth.uid()).
-- Données entièrement fictives.
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
  ('33333333-3333-3333-3333-333333333333', 'evaluateur@exemple.test');

-- Valeurs partagées entre les rôles (identifiants, retours de la RPC).
create temporary table ctx (k text primary key, v jsonb not null);
grant select, insert, update on ctx to authenticated, anon;

create function pg_temp.ctx_uuid(p_key text) returns uuid
language sql stable as $$ select (v #>> '{}')::uuid from ctx where k = p_key $$;

create function pg_temp.as_user(p_sub text) returns void
language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
$$;

-- Lot de test : 3 idées dont une sans auteur, 1 paire de doublons donnée dans
-- l'ordre « inverse » (la RPC doit ordonner idea_a < idea_b elle-même).
insert into ctx (k, v) values
('ideas', '[
  {"external_ref": "IDEA-001", "title": "Capteurs de vibration",
   "description": "Détecter l''usure des compresseurs avant la panne.",
   "expected_benefits": "Moins de pannes", "direction": "Maintenance", "site": "Lyon",
   "theme": "Énergie", "budget_raw": "40 000 €", "budget_eur": 40000,
   "submitted_at": "2026-09-15", "submitted_at_raw": "2026-09-15",
   "content_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
   "quality_flags": [], "raw": {"id": "IDEA-001", "theme": "Énergie"},
   "author": {"first_name": "Julie", "last_name": "Marchand"}},
  {"external_ref": "IDEA-002", "title": "Retards fournisseurs",
   "description": "Un tableau de bord unique des délais fournisseurs.",
   "expected_benefits": null, "direction": "Supply chain", "site": null, "theme": null,
   "budget_raw": null, "budget_eur": null, "submitted_at": null, "submitted_at_raw": null,
   "content_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
   "quality_flags": ["theme_manquant"], "raw": {},
   "author": {"first_name": "Thomas", "last_name": "Lefèvre"}},
  {"external_ref": "IDEA-007", "title": "Maintenance prédictive",
   "description": "Prévoir les pannes des compresseurs.",
   "expected_benefits": "Moins de pannes", "direction": "Maintenance", "site": "Metz",
   "theme": "Énergie", "budget_raw": null, "budget_eur": null,
   "submitted_at": "2026-09-18", "submitted_at_raw": "2026-09-18",
   "content_hash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
   "quality_flags": [], "raw": {"id": "IDEA-007"}, "author": null}
]'),
('duplicates', '[{"ref_a": "IDEA-007", "ref_b": "IDEA-001", "kind": "similar", "similarity": 0.82}]'),
('report', '{"rows_read": 4, "rows_imported": 3, "rows_rejected": 0, "rows_empty": 1}');

create function pg_temp.import_lot(p_challenge uuid, p_ideas jsonb) returns jsonb
language sql as $$
  select public.import_ideas(
    p_challenge, 'idees_hexavia.csv', p_ideas,
    (select v from ctx where k = 'duplicates'),
    (select v from ctx where k = 'report'));
$$;

-- =============================================================================
-- Structure
-- =============================================================================
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('challenges', 'challenge_members', 'import_batches',
                       'ideas', 'idea_authors', 'duplicate_pairs')
     and c.relrowsecurity),
  6, 'la RLS est activée sur les 6 tables');

select ok(
  not has_function_privilege('anon', 'public.import_ideas(uuid, text, jsonb, jsonb, jsonb)', 'execute'),
  'anon ne peut pas exécuter import_ideas');

-- =============================================================================
-- Création d'un challenge par le propriétaire
-- =============================================================================
set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');

select lives_ok(
  $$ with c as (
       insert into public.challenges (title, client_name)
       values ('Challenge Hexavia 2026', 'Hexavia') returning id)
     insert into ctx (k, v) select 'c1', to_jsonb(id) from c $$,
  'un utilisateur authentifié crée un challenge et le relit (insert ... returning)');

select is(
  (select created_by from public.challenges where id = pg_temp.ctx_uuid('c1')),
  '11111111-1111-1111-1111-111111111111'::uuid,
  'created_by vaut auth.uid() par défaut');

select is(
  (select role from public.challenge_members
   where challenge_id = pg_temp.ctx_uuid('c1')
     and user_id = '11111111-1111-1111-1111-111111111111'),
  'owner', 'le créateur devient automatiquement membre « owner »');

select throws_ok(
  $$ insert into public.challenges (title, client_name, created_by)
     values ('Usurpation', 'Client', '22222222-2222-2222-2222-222222222222') $$,
  '42501', null, 'impossible de créer un challenge au nom de quelqu''un d''autre');

select throws_ok(
  $$ insert into public.challenges (title, client_name) values ('', 'Client') $$,
  '23514', null, 'un titre vide est refusé');

-- =============================================================================
-- Import par un membre
-- =============================================================================
select lives_ok(
  $$ insert into ctx (k, v)
     select 'import1', pg_temp.import_lot(pg_temp.ctx_uuid('c1'), (select v from ctx where k = 'ideas')) $$,
  'un membre importe un lot via la RPC');

select is((select v from ctx where k = 'import1') ->> 'inserted', '3', '1er import : 3 idées insérées');
select is((select v from ctx where k = 'import1') ->> 'updated', '0', '1er import : 0 idée mise à jour');
select is((select v from ctx where k = 'import1') ->> 'duplicates_added', '1', '1er import : 1 paire ajoutée');

select is(
  (select count(*)::int from public.ideas where challenge_id = pg_temp.ctx_uuid('c1')),
  3, 'les 3 idées sont en base');

select is(
  (select count(*)::int from public.idea_authors where challenge_id = pg_temp.ctx_uuid('c1')),
  2, 'les 2 auteurs connus sont enregistrés (idée sans auteur ignorée)');

select is(
  (select row(b.rows_read, b.rows_imported, b.rows_rejected, b.rows_empty, b.imported_by, b.file_name)::text
   from public.import_batches b
   where b.id = ((select v from ctx where k = 'import1') ->> 'batch_id')::uuid),
  row(4, 3, 0, 1, '11111111-1111-1111-1111-111111111111'::uuid, 'idees_hexavia.csv'::text)::text,
  'le lot porte les compteurs du rapport, l''auteur de l''import et le nom du fichier');

select is(
  (select row(i.budget_eur, i.submitted_at, i.quality_flags, i.raw ->> 'theme')::text
   from public.ideas i
   where i.challenge_id = pg_temp.ctx_uuid('c1') and i.external_ref = 'IDEA-001'),
  row(40000.00::numeric(12,2), '2026-09-15'::date, '{}'::text[], 'Énergie'::text)::text,
  'les champs typés (budget, date, drapeaux, raw) sont stockés');

select is(
  (select array_agg(x.external_ref order by x.external_ref)
   from public.duplicate_pairs p
   join public.ideas x on x.id in (p.idea_a, p.idea_b)
   where p.challenge_id = pg_temp.ctx_uuid('c1')),
  array['IDEA-001', 'IDEA-007'], 'la paire relie IDEA-001 et IDEA-007');

select ok(
  (select bool_and(p.idea_a < p.idea_b and p.status = 'suggested' and p.decided_at is null)
   from public.duplicate_pairs p where p.challenge_id = pg_temp.ctx_uuid('c1')),
  'la paire est ordonnée (idea_a < idea_b) et en statut « suggested »');

-- =============================================================================
-- Réimport du même lot : idempotent
-- =============================================================================
select lives_ok(
  $$ insert into ctx (k, v)
     select 'import2', pg_temp.import_lot(pg_temp.ctx_uuid('c1'), (select v from ctx where k = 'ideas')) $$,
  'le même lot est réimporté');

select is((select v from ctx where k = 'import2') ->> 'inserted', '0', 'réimport : aucune idée insérée');
select is((select v from ctx where k = 'import2') ->> 'updated', '3', 'réimport : 3 idées mises à jour');
select is((select v from ctx where k = 'import2') ->> 'duplicates_added', '0', 'réimport : aucune paire ajoutée');

select is(
  (select count(*)::int from public.ideas where challenge_id = pg_temp.ctx_uuid('c1')),
  3, 'réimport : toujours 3 idées (pas de doublon)');

select is(
  (select count(*)::int from public.idea_authors where challenge_id = pg_temp.ctx_uuid('c1')),
  2, 'réimport : toujours 2 auteurs');

select is(
  (select count(distinct import_batch_id)::int from public.ideas
   where challenge_id = pg_temp.ctx_uuid('c1')
     and import_batch_id = ((select v from ctx where k = 'import2') ->> 'batch_id')::uuid),
  1, 'réimport : les idées sont rattachées au nouveau lot');

-- Une décision humaine survit au réimport, et la RPC met à jour le contenu.
select lives_ok(
  $$ update public.duplicate_pairs set status = 'dismissed'
     where challenge_id = pg_temp.ctx_uuid('c1') $$,
  'le membre écarte la paire');

select is(
  (select decided_by from public.duplicate_pairs where challenge_id = pg_temp.ctx_uuid('c1')),
  '11111111-1111-1111-1111-111111111111'::uuid,
  'la décision est signée par l''utilisateur courant (trigger)');

select lives_ok(
  $$ insert into ctx (k, v)
     select 'import3', pg_temp.import_lot(
       pg_temp.ctx_uuid('c1'),
       jsonb_set((select v from ctx where k = 'ideas'), '{0,title}', '"Capteurs de vibration v2"')) $$,
  'réimport d''un lot dont un titre a changé');

select is(
  (select title from public.ideas
   where challenge_id = pg_temp.ctx_uuid('c1') and external_ref = 'IDEA-001'),
  'Capteurs de vibration v2', 'le réimport met à jour le contenu de l''idée');

select is(
  (select status from public.duplicate_pairs where challenge_id = pg_temp.ctx_uuid('c1')),
  'dismissed', 'le réimport n''écrase pas la décision humaine sur la paire');

-- =============================================================================
-- Garde-fous de la RPC
-- =============================================================================
select throws_ok(
  $$ select public.import_ideas(pg_temp.ctx_uuid('c1'), 'vide.csv', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb) $$,
  '22023', null, 'un lot vide est refusé');

select throws_ok(
  $$ select public.import_ideas(pg_temp.ctx_uuid('c1'), 'gros.csv',
       (select jsonb_agg(jsonb_build_object('external_ref', 'X-' || g)) from generate_series(1, 2001) g),
       '[]'::jsonb, '{}'::jsonb) $$,
  '22023', null, 'un lot de plus de 2000 idées est refusé');

select throws_ok(
  $$ select public.import_ideas(pg_temp.ctx_uuid('c1'), 'paires.csv',
       (select v from ctx where k = 'ideas'),
       (select jsonb_agg(jsonb_build_object('ref_a', 'IDEA-001', 'ref_b', 'IDEA-002')) from generate_series(1, 5001)),
       '{}'::jsonb) $$,
  '22023', null, 'plus de 5000 paires sont refusées');

select throws_ok(
  $$ select public.import_ideas(pg_temp.ctx_uuid('c1'), 'double.csv',
       (select jsonb_build_array(v -> 0, v -> 0) from ctx where k = 'ideas'),
       '[]'::jsonb, '{}'::jsonb) $$,
  '22023', null, 'une référence en double dans le lot est refusée');

select throws_ok(
  $$ select public.import_ideas(pg_temp.ctx_uuid('c1'), 'inconnue.csv',
       (select v from ctx where k = 'ideas'),
       '[{"ref_a": "IDEA-001", "ref_b": "IDEA-999", "kind": "exact", "similarity": 1}]'::jsonb,
       '{}'::jsonb) $$,
  '22023', null, 'une paire vers une idée absente du lot est refusée');

select throws_ok(
  $$ select public.import_ideas(pg_temp.ctx_uuid('c1'), 'hash.csv',
       jsonb_set((select v from ctx where k = 'ideas'), '{0,content_hash}', '"pas-un-hash"'),
       '[]'::jsonb, '{}'::jsonb) $$,
  '23514', null, 'un content_hash invalide est refusé');

select is(
  (select count(*)::int from public.import_batches where challenge_id = pg_temp.ctx_uuid('c1')),
  3, 'un import refusé ne laisse aucune trace (atomicité)');

-- =============================================================================
-- Contraintes des paires
-- =============================================================================
select throws_ok(
  $$ insert into public.duplicate_pairs (challenge_id, idea_a, idea_b, kind, similarity)
     select pg_temp.ctx_uuid('c1'), greatest(a.id, b.id), least(a.id, b.id), 'exact', 1
     from public.ideas a, public.ideas b
     where a.challenge_id = pg_temp.ctx_uuid('c1') and a.external_ref = 'IDEA-001'
       and b.challenge_id = pg_temp.ctx_uuid('c1') and b.external_ref = 'IDEA-002' $$,
  '23514', null, 'une paire avec idea_a > idea_b est refusée');

select lives_ok(
  $$ with c as (
       insert into public.challenges (title, client_name)
       values ('Autre challenge', 'Autre client') returning id)
     insert into ctx (k, v) select 'c2', to_jsonb(id) from c $$,
  'le propriétaire crée un second challenge');

select lives_ok(
  $$ select pg_temp.import_lot(pg_temp.ctx_uuid('c2'), (select v from ctx where k = 'ideas')) $$,
  'import dans le second challenge (mêmes références, autre challenge)');

select throws_ok(
  $$ insert into public.duplicate_pairs (challenge_id, idea_a, idea_b, kind, similarity)
     select pg_temp.ctx_uuid('c1'), least(a.id, b.id), greatest(a.id, b.id), 'exact', 1
     from public.ideas a, public.ideas b
     where a.challenge_id = pg_temp.ctx_uuid('c1') and a.external_ref = 'IDEA-002'
       and b.challenge_id = pg_temp.ctx_uuid('c2') and b.external_ref = 'IDEA-002' $$,
  '23503', null, 'une paire entre deux challenges différents est refusée (FK composite)');

-- =============================================================================
-- Utilisateur non membre (intrus)
-- =============================================================================
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');

select is((select count(*)::int from public.challenges), 0, 'non-membre : aucun challenge visible');
select is((select count(*)::int from public.challenge_members), 0, 'non-membre : aucun membre visible');
select is((select count(*)::int from public.import_batches), 0, 'non-membre : aucun lot visible');
select is((select count(*)::int from public.ideas), 0, 'non-membre : aucune idée visible');
select is((select count(*)::int from public.idea_authors), 0, 'non-membre : aucun auteur visible');
select is((select count(*)::int from public.duplicate_pairs), 0, 'non-membre : aucune paire visible');

select throws_ok(
  $$ select pg_temp.import_lot(pg_temp.ctx_uuid('c1'), (select v from ctx where k = 'ideas')) $$,
  '42501', null, 'la RPC refuse un challenge dont l''appelant n''est pas membre');

select throws_ok(
  $$ insert into public.challenge_members (challenge_id, user_id)
     values (pg_temp.ctx_uuid('c1'), '22222222-2222-2222-2222-222222222222') $$,
  '42501', null, 'un non-membre ne peut pas s''ajouter au challenge d''autrui');

-- Écritures « à l'aveugle » : sans effet (vérifié plus bas par le propriétaire).
update public.ideas set title = 'Piraté' where challenge_id = pg_temp.ctx_uuid('c1');
delete from public.challenges where id = pg_temp.ctx_uuid('c1');

-- =============================================================================
-- Évaluateur ajouté par le propriétaire
-- =============================================================================
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');

select is(
  (select count(*)::int from public.ideas
   where challenge_id = pg_temp.ctx_uuid('c1') and title = 'Piraté'),
  0, 'la mise à jour d''un non-membre n''a rien modifié');

select lives_ok(
  $$ insert into public.challenge_members (challenge_id, user_id)
     values (pg_temp.ctx_uuid('c1'), '33333333-3333-3333-3333-333333333333') $$,
  'le propriétaire ajoute un évaluateur');

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');

select is(
  (select count(*)::int from public.ideas where challenge_id = pg_temp.ctx_uuid('c1')),
  3, 'l''évaluateur voit les idées du challenge');

select is(
  (select count(*)::int from public.ideas where challenge_id = pg_temp.ctx_uuid('c2')),
  0, 'l''évaluateur ne voit pas les idées d''un challenge dont il n''est pas membre');

select throws_ok(
  $$ insert into public.challenge_members (challenge_id, user_id)
     values (pg_temp.ctx_uuid('c1'), '22222222-2222-2222-2222-222222222222') $$,
  '42501', null, 'un évaluateur (non owner) ne peut pas ajouter de membre');

delete from public.challenges where id = pg_temp.ctx_uuid('c1');

select is(
  (select count(*)::int from public.challenges where id = pg_temp.ctx_uuid('c1')),
  1, 'un évaluateur ne peut pas supprimer le challenge (ni un non-membre)');

-- =============================================================================
-- Sans identité : authenticated sans claims, puis anon
-- =============================================================================
select set_config('request.jwt.claims', '', true);

select is((select count(*)::int from public.ideas), 0, 'sans utilisateur courant : aucune idée visible');

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok($$ select count(*) from public.challenges $$, '42501', null,
  'anon ne lit pas les challenges');
select throws_ok($$ select count(*) from public.ideas $$, '42501', null,
  'anon ne lit pas les idées');
select throws_ok($$ select count(*) from public.idea_authors $$, '42501', null,
  'anon ne lit pas les auteurs');

-- =============================================================================
-- Suppression par le propriétaire : cascade
-- =============================================================================
set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
delete from public.challenges where id = pg_temp.ctx_uuid('c1');
reset role;

select is(
  (select count(*)::int from public.ideas where challenge_id = pg_temp.ctx_uuid('c1')),
  0, 'la suppression du challenge par son owner supprime ses idées (cascade)');

select * from finish();
rollback;
