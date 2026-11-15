-- =============================================================================
-- Migration : notation des idées par des agents IA, validation humaine
-- -----------------------------------------------------------------------------
-- Ajoute :
--   * challenges.context : contexte et stratégie du client, saisi par le
--     consultant et transmis aux agents ;
--   * criteria : la grille d'évaluation d'un challenge, en lignes (un nouveau
--     client = des données, pas une migration), avec une grille par défaut de
--     4 critères créée automatiquement pour chaque challenge ;
--   * evaluations : un passage complet des agents sur une idée (analyste,
--     4 consultants, associé senior) ;
--   * criterion_assessments : l'évaluation d'un critère par un agent (note,
--     arguments, sources web) ;
--   * scores : la note finale HUMAINE par (idée, critère).
--
-- Principes (cf. CLAUDE.md §4, §5 et §7) :
--   * le challenge reste la frontière d'isolation : chaque table porte
--     challenge_id et toutes les références passent par des FK composites ;
--   * intégrité des résultats IA : evaluations et criterion_assessments sont en
--     LECTURE SEULE pour authenticated. Seul le serveur (api/, rôle
--     service_role, clé secrète jamais envoyée au navigateur) y écrit. Un
--     utilisateur ne peut donc ni fabriquer ni retoucher une note IA ;
--   * scores n'est écrit que par un humain : service_role n'y a aucun droit,
--     aucune fonction n'y écrit ; validated_by est forcé à auth.uid() ;
--   * service_role contourne la RLS (BYPASSRLS) : ses droits sont donc limités
--     par les privilèges, table par table, au strict besoin du serveur de
--     notation (pas d'accès aux données personnelles d'idea_authors).
--
-- Idempotence : « if not exists », « create or replace », « drop ... if
-- exists », « on conflict do nothing » : rejouable sans effet de bord.
-- =============================================================================

-- Verrous courts (ajout de colonne et de trigger sur challenges, FK vers
-- ideas et auth.users) : on abandonne plutôt que de bloquer la file d'attente.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- -----------------------------------------------------------------------------
-- 1. Contexte du client sur le challenge
--    Colonne nullable sans défaut : ajout instantané (pas de réécriture). Le
--    check parcourt la table une fois (quelques dizaines de lignes).
-- -----------------------------------------------------------------------------

alter table public.challenges
  add column if not exists context text
  constraint challenges_context_length_check check (char_length(context) <= 8000);

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------

-- Grille d'évaluation d'un challenge : un critère par ligne.
-- anchors : sens des niveaux de note, objet {"1": "...", "3": "...", "5": "..."},
-- injecté dans le prompt (clé de la cohérence d'une idée à l'autre).
-- key n'est pas modifiable après création (privilèges) : c'est l'identifiant
-- que les agents renvoient.
create table if not exists public.criteria (
  id           uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges (id) on delete cascade,
  key          text not null check (key ~ '^[a-z_]{2,40}$'),
  label        text not null check (char_length(label) between 1 and 120),
  description  text not null check (char_length(description) between 1 and 2000),
  weight       numeric(4, 2) not null default 1 check (weight > 0 and weight <= 10),
  position     smallint not null check (position between 1 and 100),
  anchors      jsonb not null default '{}'::jsonb
               check (jsonb_typeof(anchors) = 'object'
                      and octet_length(anchors::text) <= 10000),
  created_at   timestamptz not null default now(),
  constraint criteria_challenge_id_key_key unique (challenge_id, key),
  -- Cible des clés étrangères composites (évaluations de critère, notes).
  constraint criteria_challenge_id_id_key unique (challenge_id, id)
);
-- Filtre par challenge et FK challenge_id : couverts par les index uniques.

-- Un passage complet des agents sur une idée.
-- requested_by : pas de défaut auth.uid() (le serveur écrit en service_role,
-- sans utilisateur courant) ; le serveur y met l'identifiant vérifié du JWT de
-- l'appelant. ON DELETE RESTRICT : historique de coût et de traçabilité.
create table if not exists public.evaluations (
  id                uuid primary key default gen_random_uuid(),
  challenge_id      uuid not null,
  idea_id           uuid not null,
  status            text not null default 'running'
                    check (status in ('running', 'completed', 'failed')),
  prompt_version    text not null check (char_length(prompt_version) between 1 and 20),
  -- Empreinte de l'idée telle qu'évaluée (cache et détection d'une idée
  -- modifiée depuis).
  content_hash      text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  -- Modèle utilisé par chaque agent, ex. {"analyste": "...", "associe": "..."}.
  models            jsonb not null default '{}'::jsonb
                    check (jsonb_typeof(models) = 'object'),
  -- Données manquantes estimées par l'analyste (tableau d'objets).
  estimates         jsonb not null default '[]'::jsonb
                    check (jsonb_typeof(estimates) = 'array'),
  -- Synthèse de l'associé : texte, points forts/faibles, incohérences,
  -- recommandation argumentée.
  synthesis         jsonb check (jsonb_typeof(synthesis) = 'object'),
  recommendation    text check (recommendation in ('retenir', 'a_discuter', 'ecarter')),
  web_sources_count integer not null default 0 check (web_sources_count >= 0),
  -- Jetons consommés et coût estimé.
  usage             jsonb not null default '{}'::jsonb
                    check (jsonb_typeof(usage) = 'object'),
  error_code        text check (char_length(error_code) between 1 and 60),
  requested_by      uuid not null references auth.users (id) on delete restrict,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz,
  constraint evaluations_challenge_id_id_key unique (challenge_id, id),
  -- Cible de la FK des évaluations de critère : garantit qu'une évaluation de
  -- critère porte sur la même idée que son évaluation.
  constraint evaluations_challenge_id_idea_id_id_key unique (challenge_id, idea_id, id),
  constraint evaluations_idea_fkey
    foreign key (challenge_id, idea_id)
    references public.ideas (challenge_id, id) on delete cascade,
  -- Un passage terminé a toujours sa date de fin et sa synthèse.
  constraint evaluations_completed_check check (
    status <> 'completed' or (completed_at is not null and synthesis is not null)
  ),
  -- Un échec porte toujours un code d'erreur (sans donnée personnelle).
  constraint evaluations_failed_check check (
    status <> 'failed' or error_code is not null
  ),
  -- Un passage en cours n'est pas encore terminé.
  constraint evaluations_running_check check (
    status <> 'running' or completed_at is null
  )
);

-- Historique des passages d'une idée (le plus récent d'abord) ; sert aussi la
-- cascade depuis ideas.
create index if not exists evaluations_idea_id_created_at_idx
  on public.evaluations (idea_id, created_at desc);
create index if not exists evaluations_requested_by_idx
  on public.evaluations (requested_by);
-- Un seul passage en cours par idée : un double clic ou deux onglets ne
-- déclenchent pas deux passages payants. Le serveur passe en « failed » un
-- passage resté bloqué avant d'en relancer un.
create unique index if not exists evaluations_one_running_per_idea_idx
  on public.evaluations (idea_id) where status = 'running';

-- Évaluation d'un critère par un agent consultant.
-- details : sous-critères notés, arguments pour/contre, hypothèses, confiance.
-- sources : [{title, url, excerpt}] issues de la recherche web, 20 au plus.
create table if not exists public.criterion_assessments (
  id            uuid primary key default gen_random_uuid(),
  challenge_id  uuid not null,
  evaluation_id uuid not null,
  idea_id       uuid not null,
  criterion_id  uuid not null,
  ai_score      smallint not null check (ai_score between 1 and 5),
  summary       text not null check (char_length(summary) between 1 and 1000),
  details       jsonb not null check (jsonb_typeof(details) = 'object'),
  sources       jsonb not null default '[]'::jsonb
                check (jsonb_typeof(sources) = 'array'
                       and jsonb_array_length(sources) <= 20),
  model         text not null check (char_length(model) between 1 and 100),
  created_at    timestamptz not null default now(),
  constraint criterion_assessments_evaluation_id_criterion_id_key
    unique (evaluation_id, criterion_id),
  -- Cible de scores.based_on_assessment_id : la note humaine ne peut
  -- s'appuyer que sur une évaluation de la même idée et du même critère.
  constraint criterion_assessments_idea_id_criterion_id_id_key
    unique (idea_id, criterion_id, id),
  -- Même challenge ET même idée que l'évaluation parente.
  constraint criterion_assessments_evaluation_fkey
    foreign key (challenge_id, idea_id, evaluation_id)
    references public.evaluations (challenge_id, idea_id, id) on delete cascade,
  constraint criterion_assessments_idea_fkey
    foreign key (challenge_id, idea_id)
    references public.ideas (challenge_id, id) on delete cascade,
  constraint criterion_assessments_criterion_fkey
    foreign key (challenge_id, criterion_id)
    references public.criteria (challenge_id, id) on delete cascade
);

-- evaluation_id et idea_id sont couverts par les index uniques ci-dessus ;
-- criterion_id a besoin du sien (cascade à la suppression d'un critère).
create index if not exists criterion_assessments_criterion_id_idx
  on public.criterion_assessments (criterion_id);

-- Note finale HUMAINE par (idée, critère). Le score global n'est pas stocké
-- (calculé dans src/domain/).
-- validated_by : ON DELETE RESTRICT, une note validée porte la signature de
-- son auteur (traçabilité).
create table if not exists public.scores (
  idea_id                uuid not null,
  criterion_id           uuid not null,
  challenge_id           uuid not null,
  final_score            smallint not null check (final_score between 1 and 5),
  final_comment          text check (char_length(final_comment) <= 2000),
  based_on_assessment_id uuid,
  validated_by           uuid not null default auth.uid()
                         references auth.users (id) on delete restrict,
  validated_at           timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (idea_id, criterion_id),
  constraint scores_idea_fkey
    foreign key (challenge_id, idea_id)
    references public.ideas (challenge_id, id) on delete cascade,
  constraint scores_criterion_fkey
    foreign key (challenge_id, criterion_id)
    references public.criteria (challenge_id, id) on delete cascade,
  -- L'évaluation IA de référence doit porter sur la même idée et le même
  -- critère. Si elle disparaît, seule la référence passe à NULL (PG 15+) :
  -- la note humaine reste.
  constraint scores_based_on_assessment_fkey
    foreign key (idea_id, criterion_id, based_on_assessment_id)
    references public.criterion_assessments (idea_id, criterion_id, id)
    on delete set null (based_on_assessment_id)
);

-- Notes d'un challenge et cascade depuis criteria ; idea_id est couvert par la
-- clé primaire, based_on_assessment_id par la clé primaire + la colonne.
create index if not exists scores_challenge_id_criterion_id_idx
  on public.scores (challenge_id, criterion_id);
create index if not exists scores_validated_by_idx
  on public.scores (validated_by);

-- -----------------------------------------------------------------------------
-- 3. Fonctions
-- -----------------------------------------------------------------------------

-- Insère la grille par défaut (4 critères, même poids) dans un challenge.
-- Sans effet sur un critère déjà présent (on conflict do nothing).
-- SECURITY DEFINER : appelée par le trigger de création de challenge, avant
-- que la RLS ne reconnaisse le créateur comme owner. Non exécutable par les
-- clients (cf. privilèges).
create or replace function public.insert_default_criteria(p_challenge_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.criteria (challenge_id, key, label, description, weight, position, anchors)
  values
  (
    p_challenge_id, 'impact', 'Impact pour l''entreprise',
    'Gains attendus si l''idée est déployée : retour sur investissement et gains '
    'financiers (économies, chiffre d''affaires), impact social (conditions de '
    'travail, sécurité, qualité de vie au travail), impact environnemental '
    '(énergie, émissions, déchets) et ampleur (nombre de salariés et de sites '
    'concernés).',
    1, 1,
    jsonb_build_object(
      '1', 'Gain marginal ou non démontré : bénéfice local, limité à une équipe '
           'ou à un poste, sans effet mesurable sur les coûts, la sécurité ou '
           'l''environnement.',
      '3', 'Gain réel et mesurable sur un périmètre significatif (un site ou une '
           'direction, quelques centaines de salariés) : économies de quelques '
           'dizaines de milliers d''euros par an, ou progrès notable sur la '
           'sécurité, les conditions de travail ou l''empreinte environnementale.',
      '5', 'Gain majeur à l''échelle du groupe : plusieurs sites ou une large part '
           'des quelque 4 000 salariés, retour sur investissement élevé (plusieurs '
           'centaines de milliers d''euros par an ou retour en moins d''un an), ou '
           'effet fort et durable sur la sécurité, la qualité de vie au travail ou '
           'les émissions.'
    )
  ),
  (
    p_challenge_id, 'faisabilite', 'Faisabilité',
    'Capacité à mettre l''idée en œuvre. Court terme : quick win possible en '
    'moins de 6 mois, coût, ressources et compétences disponibles en interne. '
    'Long terme : déploiement sur plusieurs sites, maintenance, risques '
    'techniques et réglementaires, conduite du changement.',
    1, 2,
    jsonb_build_object(
      '1', 'Mise en œuvre très incertaine : technologie non maîtrisée, '
           'investissement lourd sans financement identifié, compétences absentes '
           'en interne, obstacle réglementaire ou forte résistance au changement '
           'prévisible.',
      '3', 'Réalisable avec un effort réel : projet de 6 à 18 mois, budget à '
           'arbitrer, appui externe ponctuel, risques techniques ou '
           'organisationnels identifiés mais maîtrisables ; déploiement sur les '
           'autres sites à préparer.',
      '5', 'Quick win : mise en œuvre en moins de 6 mois, coût modéré, compétences '
           'internes existantes, risques faibles ; déploiement simple sur les '
           'autres sites et maintenance légère.'
    )
  ),
  (
    p_challenge_id, 'alignement', 'Alignement stratégique',
    'Cohérence de l''idée avec la stratégie et les priorités du client décrites '
    'dans le contexte du challenge : RSE et décarbonation, performance '
    'financière, excellence opérationnelle, transformation digitale, santé et '
    'sécurité.',
    1, 3,
    jsonb_build_object(
      '1', 'Sans lien avec les priorités stratégiques du client, voire en '
           'contradiction avec elles.',
      '3', 'Contribue indirectement à une priorité stratégique du client, ou '
           'directement à un objectif secondaire.',
      '5', 'Répond directement à un axe prioritaire de la feuille de route du '
           'client (objectif chiffré de décarbonation, programme d''excellence '
           'opérationnelle, plan de transformation digitale, sécurité) et en '
           'accélère l''atteinte.'
    )
  ),
  (
    p_challenge_id, 'innovation', 'Caractère innovant',
    'Nouveauté de l''idée par rapport au marché, aux concurrents et aux '
    'pratiques actuelles de l''entreprise, maturité de la technologie et '
    'potentiel de différenciation. La note s''appuie sur une analyse de marché '
    '(solutions existantes, pratiques des concurrents).',
    1, 4,
    jsonb_build_object(
      '1', 'Pratique déjà courante dans le secteur ou déjà en place dans '
           'l''entreprise ; solution standard disponible sur étagère, sans '
           'différenciation.',
      '3', 'Adaptation originale d''une solution existant ailleurs : nouvelle pour '
           'l''entreprise ou peu répandue chez les concurrents, avec une '
           'technologie mature.',
      '5', 'Approche rare ou inédite dans le secteur, source d''un avantage '
           'concurrentiel durable ; technologie récente mais assez mature pour '
           'un pilote.'
    )
  )
  on conflict (challenge_id, key) do nothing;
$$;

-- Trigger : chaque nouveau challenge reçoit la grille par défaut.
create or replace function public.add_default_criteria()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.insert_default_criteria(new.id);
  return null;
end;
$$;

-- Signe et horodate une note humaine : le client ne peut ni l'attribuer à
-- quelqu'un d'autre ni l'antidater. Sans utilisateur courant (maintenance
-- en propriétaire), la valeur fournie est conservée.
-- Exception : la seule perte de la référence à l'évaluation IA (FK « on
-- delete set null ») n'est pas une nouvelle validation, la signature reste.
create or replace function public.stamp_score_validation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and old.based_on_assessment_id is not null
     and new.based_on_assessment_id is null
     and (new.final_score, new.final_comment, new.validated_by)
         is not distinct from (old.final_score, old.final_comment, old.validated_by)
  then
    return new;
  end if;

  new.validated_by := coalesce((select auth.uid()), new.validated_by);
  new.validated_at := now();
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Triggers
-- -----------------------------------------------------------------------------

drop trigger if exists challenges_add_default_criteria on public.challenges;
create trigger challenges_add_default_criteria
  after insert on public.challenges
  for each row execute function public.add_default_criteria();

drop trigger if exists scores_stamp_validation on public.scores;
create trigger scores_stamp_validation
  before insert or update on public.scores
  for each row execute function public.stamp_score_validation();

-- -----------------------------------------------------------------------------
-- 5. Grille par défaut des challenges existants (rattrapage)
--    Uniquement ceux qui n'ont aucun critère : une grille déjà personnalisée
--    n'est jamais complétée ni modifiée.
-- -----------------------------------------------------------------------------

select public.insert_default_criteria(c.id)
from public.challenges as c
where not exists (
  select 1 from public.criteria as cr where cr.challenge_id = c.id
);

-- -----------------------------------------------------------------------------
-- 6. Privilèges
--    Supabase accorde par défaut ALL à anon, authenticated et service_role sur
--    les nouvelles tables, et EXECUTE à PUBLIC sur les fonctions : on repart
--    de zéro et on accorde le strict nécessaire.
--
--    service_role contourne la RLS : on retire aussi ses droits par défaut sur
--    les tables de la migration précédente et on ne lui rend que ce dont le
--    serveur de notation a besoin. En particulier : aucun accès à
--    idea_authors (données personnelles), aucune écriture dans scores.
-- -----------------------------------------------------------------------------

revoke all on table
  public.criteria, public.evaluations, public.criterion_assessments, public.scores
from anon, authenticated, service_role, public;

revoke all on table
  public.challenges, public.challenge_members, public.import_batches,
  public.ideas, public.idea_authors, public.duplicate_pairs
from service_role;

-- authenticated ---------------------------------------------------------------
grant insert (context), update (context) on public.challenges to authenticated;

grant select, delete on public.criteria to authenticated;
grant insert (challenge_id, key, label, description, weight, position, anchors)
  on public.criteria to authenticated;
grant update (label, description, weight, position, anchors)
  on public.criteria to authenticated;

-- Résultats IA : lecture seule.
grant select on public.evaluations to authenticated;
grant select on public.criterion_assessments to authenticated;

grant select, delete on public.scores to authenticated;
grant insert (idea_id, criterion_id, challenge_id, final_score, final_comment,
              based_on_assessment_id, validated_by)
  on public.scores to authenticated;
grant update (final_score, final_comment, based_on_assessment_id, validated_by)
  on public.scores to authenticated;

-- service_role (serveur de notation, api/) -----------------------------------
-- Lecture : l'idée (sans auteur), le challenge (contexte), la grille, et
-- l'appartenance pour vérifier que l'appelant est membre du challenge avant
-- d'écrire (la RLS ne s'applique pas à service_role).
grant select on public.challenges, public.challenge_members, public.ideas,
                public.criteria
  to service_role;
-- Écriture des résultats IA. Pas de DELETE : l'historique reste.
grant select, insert, update on public.evaluations to service_role;
grant select, insert, update on public.criterion_assessments to service_role;

-- Fonctions ---------------------------------------------------------------------
revoke all on function public.insert_default_criteria(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.add_default_criteria()
  from public, anon, authenticated, service_role;
revoke all on function public.stamp_score_validation()
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 7. Row Level Security (mêmes choix que la migration précédente : pas de
--    FORCE, une politique par opération, rôle authenticated uniquement).
--    evaluations et criterion_assessments : SELECT seulement ; l'absence de
--    politique et de privilège d'écriture refuse toute écriture cliente.
-- -----------------------------------------------------------------------------

alter table public.criteria              enable row level security;
alter table public.evaluations           enable row level security;
alter table public.criterion_assessments enable row level security;
alter table public.scores                enable row level security;

-- criteria : lecture par les membres, grille modifiée par l'owner seulement --
drop policy if exists criteria_select on public.criteria;
create policy criteria_select on public.criteria
  for select to authenticated
  using (public.is_challenge_member(challenge_id));

drop policy if exists criteria_insert on public.criteria;
create policy criteria_insert on public.criteria
  for insert to authenticated
  with check (public.is_challenge_owner(challenge_id));

drop policy if exists criteria_update on public.criteria;
create policy criteria_update on public.criteria
  for update to authenticated
  using (public.is_challenge_owner(challenge_id))
  with check (public.is_challenge_owner(challenge_id));

drop policy if exists criteria_delete on public.criteria;
create policy criteria_delete on public.criteria
  for delete to authenticated
  using (public.is_challenge_owner(challenge_id));

-- evaluations -------------------------------------------------------------------
drop policy if exists evaluations_select on public.evaluations;
create policy evaluations_select on public.evaluations
  for select to authenticated
  using (public.is_challenge_member(challenge_id));

-- criterion_assessments -------------------------------------------------------
drop policy if exists criterion_assessments_select on public.criterion_assessments;
create policy criterion_assessments_select on public.criterion_assessments
  for select to authenticated
  using (public.is_challenge_member(challenge_id));

-- scores : les membres valident, corrigent ou retirent une note --------------
drop policy if exists scores_select on public.scores;
create policy scores_select on public.scores
  for select to authenticated
  using (public.is_challenge_member(challenge_id));

drop policy if exists scores_insert on public.scores;
create policy scores_insert on public.scores
  for insert to authenticated
  with check (
    public.is_challenge_member(challenge_id)
    and validated_by = (select auth.uid())
  );

drop policy if exists scores_update on public.scores;
create policy scores_update on public.scores
  for update to authenticated
  using (public.is_challenge_member(challenge_id))
  with check (
    public.is_challenge_member(challenge_id)
    and validated_by = (select auth.uid())
  );

drop policy if exists scores_delete on public.scores;
create policy scores_delete on public.scores
  for delete to authenticated
  using (public.is_challenge_member(challenge_id));

reset statement_timeout;
reset lock_timeout;
