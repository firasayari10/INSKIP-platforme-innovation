-- =============================================================================
-- Tests pgTAP de la migration « inscription réservée aux domaines autorisés »
-- (supabase test db). Tout s'exécute dans une transaction annulée à la fin :
-- aucune donnée ne reste. Les écritures de Supabase Auth sont simulées par des
-- INSERT/UPDATE directs sur auth.users. Données entièrement fictives.
--
-- Le contrôle différé (trigger _commit) ne s'exécuterait qu'à la validation de
-- la transaction, qui n'arrive jamais ici (rollback) : on le passe en mode
-- IMMEDIATE, ce qui le fait jouer à la fin de chaque instruction, comme pour
-- une transaction d'une seule instruction. Le parcours d'invitation (INSERT
-- puis UPDATE de invited_at) est rejoué par pg_temp.simulate_invite, qui
-- repasse en DEFERRED le temps des deux écritures.
-- =============================================================================
begin;

create extension if not exists pgtap with schema extensions;

select plan(34);

set constraints auth.auth_users_enforce_signup_domain_commit immediate;

-- Invitation telle que Supabase Auth la fait : INSERT sans invited_at ni mot
-- de passe, puis UPDATE de invited_at, dans la même transaction ; le contrôle
-- différé joue ensuite (SET CONSTRAINTS ... IMMEDIATE = « validation »).
create function pg_temp.simulate_invite(p_id uuid, p_email text) returns void
language plpgsql as $$
begin
  set constraints auth.auth_users_enforce_signup_domain_commit deferred;
  insert into auth.users (id, email) values (p_id, p_email);
  update auth.users set invited_at = now() where id = p_id;
  set constraints auth.auth_users_enforce_signup_domain_commit immediate;
end;
$$;

-- Même parcours, mais sans l'UPDATE d'invitation (création sans mot de passe :
-- lien magique, OAuth, création admin non invitée).
create function pg_temp.simulate_passwordless(p_id uuid, p_email text) returns void
language plpgsql as $$
begin
  set constraints auth.auth_users_enforce_signup_domain_commit deferred;
  insert into auth.users (id, email) values (p_id, p_email);
  set constraints auth.auth_users_enforce_signup_domain_commit immediate;
end;
$$;

-- =============================================================================
-- Structure et privilèges
-- =============================================================================
select ok(
  (select relrowsecurity from pg_class where oid = 'public.signup_allowed_domains'::regclass),
  'la RLS est activée sur signup_allowed_domains');

select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.signup_allowed_domains'::regclass),
  'la RLS n''est pas forcée (les fonctions SECURITY DEFINER lisent la table)');

select is(
  (select count(*)::int from pg_policies
   where schemaname = 'public' and tablename = 'signup_allowed_domains'),
  0, 'signup_allowed_domains n''a aucune politique');

select ok(
  not has_any_column_privilege('anon', 'public.signup_allowed_domains', 'select')
  and not has_any_column_privilege('anon', 'public.signup_allowed_domains', 'insert')
  and not has_any_column_privilege('anon', 'public.signup_allowed_domains', 'update')
  and not has_table_privilege('anon', 'public.signup_allowed_domains', 'delete')
  and not has_any_column_privilege('authenticated', 'public.signup_allowed_domains', 'select')
  and not has_any_column_privilege('authenticated', 'public.signup_allowed_domains', 'insert')
  and not has_any_column_privilege('authenticated', 'public.signup_allowed_domains', 'update')
  and not has_table_privilege('authenticated', 'public.signup_allowed_domains', 'delete'),
  'anon et authenticated n''ont aucun droit sur signup_allowed_domains');

select ok(
  has_function_privilege('anon', 'public.signup_domain_allowed(text)', 'execute')
  and has_function_privilege('authenticated', 'public.signup_domain_allowed(text)', 'execute'),
  'anon et authenticated peuvent exécuter signup_domain_allowed');

select ok(
  not has_function_privilege('anon', 'public.enforce_signup_domain()', 'execute')
  and not has_function_privilege('authenticated', 'public.enforce_signup_domain()', 'execute'),
  'la fonction de trigger n''est pas exécutable par les clients');

select is(
  (select array_agg(tgname::text order by tgname) from pg_trigger
   where tgrelid = 'auth.users'::regclass and tgname like 'auth_users_enforce_signup_domain_%'),
  array['auth_users_enforce_signup_domain_commit',
        'auth_users_enforce_signup_domain_insert',
        'auth_users_enforce_signup_domain_update'],
  'les trois triggers existent sur auth.users');

select ok(
  (select tgdeferrable and tginitdeferred from pg_trigger
   where tgrelid = 'auth.users'::regclass and tgname = 'auth_users_enforce_signup_domain_commit'),
  'le contrôle _commit est différé à la validation de la transaction');

select is(
  (select array_agg(domain order by domain) from public.signup_allowed_domains),
  array['inskip.fr'], 'le domaine initial est inskip.fr');

-- Le format des domaines est contrôlé en base.
select throws_ok(
  $$ insert into public.signup_allowed_domains (domain) values ('Exemple.fr') $$,
  '23514', null, 'un domaine avec majuscules est refusé');

select throws_ok(
  $$ insert into public.signup_allowed_domains (domain) values ('@exemple.fr') $$,
  '23514', null, 'un domaine avec « @ » est refusé');

select throws_ok(
  $$ insert into public.signup_allowed_domains (domain) values ('exemple') $$,
  '23514', null, 'un domaine sans point est refusé');

-- =============================================================================
-- Pré-contrôle signup_domain_allowed
-- =============================================================================
select is(public.signup_domain_allowed('alice@inskip.fr'), true,
  'adresse @inskip.fr : autorisée');
select is(public.signup_domain_allowed('  Alice@INSKIP.FR  '), true,
  'casse et espaces ignorés');
select is(public.signup_domain_allowed('alice@gmail.com'), false,
  'adresse @gmail.com : refusée');
select is(public.signup_domain_allowed('alice@evil.inskip.fr'), false,
  'sous-domaine : refusé (correspondance exacte)');
select is(public.signup_domain_allowed('alice@inskip.fr.evil.com'), false,
  'domaine piège inskip.fr.evil.com : refusé');
select is(public.signup_domain_allowed('alice@inskip.fr@gmail.com'), false,
  'seule la partie après le dernier « @ » compte');
select is(public.signup_domain_allowed(null), false, 'NULL : false (jamais NULL)');
select is(public.signup_domain_allowed(''), false, 'chaîne vide : false');
select is(public.signup_domain_allowed('inskip.fr'), false, 'sans « @ » : false');

-- =============================================================================
-- Rôle anon (formulaire d'inscription, avant connexion)
-- =============================================================================
set local role anon;

select throws_ok(
  $$ select count(*) from public.signup_allowed_domains $$,
  '42501', null, 'anon ne peut pas lire la liste des domaines');

select is(public.signup_domain_allowed('bob@inskip.fr'), true,
  'anon exécute signup_domain_allowed (et la fonction voit la table)');

reset role;

-- =============================================================================
-- Inscriptions (INSERT dans auth.users)
-- =============================================================================
select lives_ok(
  $$ insert into auth.users (id, email, encrypted_password) values
     ('a0000000-0000-0000-0000-000000000001', 'alice@inskip.fr', 'hash-fictif') $$,
  'inscription par mot de passe @inskip.fr acceptée');

select lives_ok(
  $$ insert into auth.users (id, email, encrypted_password) values
     ('a0000000-0000-0000-0000-000000000002', 'Bob@INSKIP.FR', 'hash-fictif') $$,
  'inscription @INSKIP.FR acceptée (casse ignorée)');

select throws_ok(
  $$ insert into auth.users (id, email, encrypted_password) values
     ('a0000000-0000-0000-0000-000000000003', 'carol@gmail.com', 'hash-fictif') $$,
  'P0001', 'signup_domain_not_allowed', 'inscription par mot de passe @gmail.com refusée');

select throws_ok(
  $$ insert into auth.users (id, email, encrypted_password) values
     ('a0000000-0000-0000-0000-000000000004', 'dan@evil.inskip.fr', 'hash-fictif') $$,
  'P0001', 'signup_domain_not_allowed', 'sous-domaine @evil.inskip.fr refusé');

select throws_ok(
  $$ insert into auth.users (id, email, encrypted_password) values
     ('a0000000-0000-0000-0000-000000000005', 'eve@inskip.fr.evil.com', 'hash-fictif') $$,
  'P0001', 'signup_domain_not_allowed', 'domaine piège inskip.fr.evil.com refusé');

select throws_ok(
  $$ select pg_temp.simulate_passwordless('a0000000-0000-0000-0000-000000000006', 'frank@gmail.com') $$,
  'P0001', 'signup_domain_not_allowed',
  'création sans mot de passe ni invitation @gmail.com refusée à la validation');

-- =============================================================================
-- Invitations (n'importe quel domaine)
-- =============================================================================
select lives_ok(
  $$ select pg_temp.simulate_invite('b0000000-0000-0000-0000-000000000001', 'invitee@gmail.com') $$,
  'invitation @gmail.com acceptée (INSERT puis invited_at, comme Supabase Auth)');

select lives_ok(
  $$ insert into auth.users (id, email, invited_at) values
     ('b0000000-0000-0000-0000-000000000002', 'invitee2@gmail.com', now()) $$,
  'utilisateur créé déjà invité @gmail.com accepté');

-- =============================================================================
-- Comptes existants et changements d'adresse
-- =============================================================================
-- Compte @gmail.com antérieur à la règle, jamais invité : créé ici comme
-- invité puis invited_at remis à NULL (aucun trigger sur cette colonne).
insert into auth.users (id, email, invited_at) values
  ('c0000000-0000-0000-0000-000000000001', 'ancien@gmail.com', now());
update auth.users set invited_at = null
where id = 'c0000000-0000-0000-0000-000000000001';

select lives_ok(
  $$ update auth.users set encrypted_password = 'nouveau-hash'
     where id = 'c0000000-0000-0000-0000-000000000001' $$,
  'compte existant @gmail.com : mise à jour d''un autre champ acceptée');

select throws_ok(
  $$ update auth.users set email = 'alice@gmail.com'
     where id = 'a0000000-0000-0000-0000-000000000001' $$,
  'P0001', 'signup_domain_not_allowed',
  'un inscrit @inskip.fr ne peut pas passer à une adresse @gmail.com');

select lives_ok(
  $$ update auth.users set email = 'invitee-nouvelle@exemple.test'
     where id = 'b0000000-0000-0000-0000-000000000001' $$,
  'un invité peut changer d''adresse vers un autre domaine');

select * from finish();
rollback;
