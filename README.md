# Challenge Innovation — évaluation des idées

Application web pour évaluer les idées déposées lors d'un challenge d'innovation interne :
import, notation assistée par IA, détection des doublons et shortlist pour le jury.

> Documentation en cours de rédaction : les parties **Cadrage**, **Conception** et
> **Hypothèses** seront complétées au fil des fonctionnalités.

## Démarrage local

Prérequis : [Bun](https://bun.sh) 1.2+ et un projet [Supabase](https://supabase.com).

```bash
bun install
cp .env.example .env.local   # puis renseigner les valeurs
bun dev                      # http://localhost:3000
```

| Commande | Rôle |
|---|---|
| `bun dev` | Serveur de développement avec rechargement à chaud |
| `bun test` | Tests automatisés |
| `bun run typecheck` | Vérification des types TypeScript |
| `bun run build` | Build de production dans `dist/` |

## Configuration de l'authentification (Supabase)

Connexion sans mot de passe, réservée aux personnes invitées (voir
[ADR 0001](docs/adr/0001-authentification.md)). Dans le tableau de bord Supabase :

1. **Authentication → Sign In / Providers → Email** : activer le fournisseur E-mail.
2. **Authentication → Sign In / Providers** : **désactiver « Allow new users to sign up »**.
   C'est ce réglage qui garantit l'accès sur invitation.
3. **Authentication → URL Configuration** :
   - *Site URL* : l'adresse de l'application, **sans chemin** (`http://localhost:3000` en local,
     `https://<app>.vercel.app` en production) ;
   - *Redirect URLs* : `http://localhost:3000/auth/callback` et
     `https://<app>.vercel.app/auth/callback` (ajouter aussi le motif des previews Vercel si besoin).
4. **Authentication → Emails → Magic Link** : le lien pointe directement vers l'application
   (`token_hash`) et l'e-mail contient aussi le code. Ce format fonctionne dans n'importe quel
   navigateur et résiste aux antivirus de messagerie qui « cliquent » les liens à l'avance.

   ```html
   <h2>Connexion à Challenge Innovation</h2>
   <p><a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email">Se connecter</a></p>
   <p>Ou saisissez ce code : <strong>{{ .Token }}</strong></p>
   <p>Ce lien et ce code sont valables une heure. Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.</p>
   ```
5. **Authentication → Emails → Invite user** :

   ```html
   <h2>Vous êtes invité sur Challenge Innovation</h2>
   <p>Vous avez été invité à évaluer les idées d'un challenge d'innovation.</p>
   <p><a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=invite">Accepter l'invitation</a></p>
   <p>Ce lien est valable 24 heures. Ensuite, connectez-vous simplement avec votre adresse e-mail.</p>
   ```
6. **Authentication → Users → Invite user** : inviter chaque évaluateur. Aucun mot de passe
   n'est demandé : les connexions suivantes se font par lien ou par code.
7. Copier l'URL du projet et la **clé publishable** (Project Settings → API Keys) dans
   `.env.local`. Ne jamais utiliser la clé secrète côté navigateur : l'application refuse
   de démarrer si c'est le cas.

**Envoi des e-mails** : le service d'e-mail intégré de Supabase est limité à quelques envois
par heure et n'écrit qu'aux membres de l'organisation Supabase. Pour inviter d'autres
personnes, configurer un SMTP (Authentication → Emails → SMTP Settings).

## Base de données (migrations)

Le schéma est versionné dans `supabase/migrations/`, avec ses tests dans `supabase/tests/`.

```bash
bunx supabase link --project-ref <ref-du-projet>   # une seule fois
bunx supabase db push --remote                     # applique les nouvelles migrations
```

La CLI Supabase 3 vise la base **locale** par défaut : `--remote` est indispensable pour le
projet en ligne. Lancée depuis un assistant de code, elle exige en plus `--yes`, qui vaut
confirmation explicite.

## Import des idées : hypothèses

- Fichier **CSV** (séparateur `;` ou `,`, UTF-8 ou Windows-1252), 5 Mo et 2 000 lignes au maximum.
- Colonnes reconnues : `id`, `date_depot`, `prenom`, `nom`, `direction`, `site`, `theme`,
  `titre`, `description`, `benefices_attendus`, `budget_estime` (en-têtes tolérants : casse,
  accents, espaces). Obligatoires : `id`, `titre`, `description`.
- Ligne rejetée : identifiant, titre ou description manquant, identifiant répété, texte anormalement
  long. Ligne importée mais signalée : thème, site ou direction absents, budget absent ou non
  chiffré, date convertie, description très courte, cellule ressemblant à une formule.
- Budgets convertis en euros (« 15k€ » → 15 000), saisie d'origine toujours conservée.
- Doublons : contenu identique (certain) ou formulation proche (similarité ≥ 28 %). Rien n'est
  fusionné automatiquement. Limite : la même idée formulée avec d'autres mots n'est pas détectée.
- Prénom et nom sont stockés à part (`idea_authors`) et n'apparaissent ni dans la ligne source
  conservée ni dans le rapport d'analyse.
- Réimporter un fichier met à jour les idées existantes (même identifiant) sans les dupliquer.

## Notation par les agents

La notation est **automatique et ne demande aucun renseignement préalable** : une idée jamais
évaluée l'est dès l'ouverture de sa fiche, et « Évaluer toutes les idées » (page du challenge)
note tout le challenge en une fois. Elle fait travailler une équipe d'agents IA
(voir [ADR 0002](docs/adr/0002-notation-par-agents.md)) :

1. **Analyste** : estime les données manquantes (budget en fourchette, bénéfices…) avec méthode,
   hypothèses et sources. Ces estimations sont affichées comme telles et ne modifient pas les
   données importées.
2. **Quatre consultants**, un par critère (impact, faisabilité, alignement stratégique, caractère
   innovant), avec recherche web : note 1–5, sous-critères notés, arguments pour/contre,
   hypothèses, confiance et sources consultables.
3. **Associé senior** : synthèse pour le jury, incohérences, recommandation (retenir / à discuter /
   écarter) et prochaines étapes.

L'évaluateur valide ensuite la note de chaque critère (il peut la corriger et la commenter) ; la
note finale est la moyenne pondérée des notes validées.

Configuration (`.env.local` en local, variables Vercel en production ; voir `.env.example`) :
`SUPABASE_SECRET_KEY` et la clé d'un fournisseur d'IA :
- **Z.ai (GLM)**, par défaut si `ZAI_API_KEY` est défini : modèle `glm-5.2` pour les trois rôles,
  recherche web intégrée (outil `web_search`) ;
- **OpenRouter** (`LLM_PROVIDER=openrouter`, `OPENROUTER_API_KEY`) : un modèle par rôle.

### Limitation de débit

- **Vers le fournisseur d'IA** (`src/server/rateLimiter.ts`), partagée par toutes les évaluations
  du serveur : au plus `LLM_MAX_CONCURRENT` appels simultanés (2), `LLM_REQUESTS_PER_MINUTE` (20)
  et `LLM_MIN_INTERVAL_MS` entre deux appels (500 ms). Sur saturation (HTTP 429, codes Z.ai
  1302/1303/1305), tous les appels se mettent en pause (`Retry-After` ou attente exponentielle
  2 s, 4 s, 8 s… plafonnée à 60 s), jusqu'à 4 nouvelles tentatives.
- **Par utilisateur** : au plus `EVALUATIONS_PER_HOUR` évaluations lancées par heure (60), comptées
  en base ; une évaluation réutilisée (déjà faite) ne compte pas.
- L'évaluation tourne **en arrière-plan** : le serveur répond aussitôt et la page suit
  l'avancement. Limite connue : en hébergement serverless (Vercel), chaque instance a son propre
  limiteur et le travail d'arrière-plan devra passer par `waitUntil`.

### Hypothèses

- **Contexte du client supposé.** Faute de stratégie communiquée par le client, les agents
  partent de l'hypothèse de travail suivante (affichée comme telle sur la page du challenge et
  signalée aux agents comme non confirmée) :

  > Groupe industriel français spécialisé dans la fabrication d'équipements et de composants
  > industriels, environ 4 000 salariés répartis sur 8 sites de production en France et en Europe.
  > Stratégie RSE : réduire les émissions de CO₂ de 30 % d'ici 2030, améliorer l'efficacité
  > énergétique des sites et renforcer la sécurité au travail, avec un objectif de zéro accident grave.
  > Stratégie financière : gagner 2 points de marge opérationnelle sur les trois prochaines années,
  > en privilégiant les investissements à retour rapide (ROI inférieur à 3 ans).
  > Priorités : amélioration de la performance industrielle, réduction des arrêts de production,
  > maintenance prédictive, automatisation des processus, digitalisation des ateliers et
  > fidélisation des talents.

  Le consultant peut le remplacer par le contexte réel (« Personnaliser ») ; les évaluations
  suivantes l'utiliseront.
- La notation automatique n'est jamais relancée seule après un échec (pas d'appels payants en
  boucle). Une évaluation par lot s'arrête d'elle-même si la clé ou le crédit du fournisseur d'IA
  pose problème, et traite deux idées à la fois.
- Une source n'est affichée que si l'agent l'a réellement trouvée par sa recherche web ; les
  données boursières proviennent uniquement de pages publiques (pas d'API financière en V1).
- Une évaluation identique (même contenu, mêmes consignes, mêmes modèles) est réutilisée au lieu
  d'être refacturée ; « Relancer l'évaluation » force un nouveau passage.

### Prochaine étape

Dialogue avec l'IA sur la fiche d'une idée : l'évaluateur pourra demander l'explication d'une
note et apporter des informations (contexte réel, chiffres du porteur de l'idée) qui seront
prises en compte dans une nouvelle évaluation.

## Consultation des idées : hypothèses

- La liste affiche toutes les colonnes de l'idée ; les filtres (recherche, direction, thème, site,
  points d'attention, doublons) sont gardés dans l'adresse de la page : ils survivent à un
  rechargement et se partagent par lien.
- Prénom et nom de l'auteur ne figurent pas dans la liste (minimisation) : ils ne sont visibles
  que sur la fiche de l'idée.
- « Doublon possible » = idée présente dans une paire détectée et non écartée.

## Sécurité

- Projet Supabase hébergé dans l'Union européenne (`eu-north-1`, Stockholm) : les données
  personnelles des auteurs d'idées restent dans l'UE.

- Aucun secret dans le dépôt : `.env.local` est ignoré, `.env.example` documente les variables.
- Seules les variables `BUN_PUBLIC_*` sont intégrées au code du navigateur.
- Le détail des règles est dans [CLAUDE.md](CLAUDE.md) §7.
