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

## Interface : hypothèses

Spécification complète : [docs/design/direction-ui.md](docs/design/direction-ui.md).

- Les écrans de données sont des grilles façon tableur (tri par en-tête, filtre par colonne avec
  cases à cocher, recherche, barre d'état), sans dépendance ajoutée.
- Le **numéro de ligne** affiché est la position dans la vue (1…n après tri et filtres), pas un
  identifiant : l'identifiant reste la colonne « Réf. ».
- Tri, filtres, recherche et cellule active **ne sont pas conservés** d'une page à l'autre (perdus à
  la navigation ou au rechargement) : hypothèse la plus simple pour la V1.
- Une seule colonne de tri à la fois ; à valeur égale, les lignes restent dans l'ordre du tri par
  défaut (Réf. croissante pour les idées). Les cellules vides sont toujours en bas.
- Filtre du budget par **tranches fixes** : moins de 10 000 €, de 10 000 € à 50 000 €, de 50 000 € à
  100 000 €, 100 000 € et plus (borne basse incluse), « Non chiffré » (saisie sans montant lisible),
  « (Vides) » (aucune saisie). Date de dépôt filtrée par mois.
- « Somme des budgets affichés » additionne les montants connus des lignes affichées ; les lignes
  sans montant (non chiffrées ou vides) sont comptées à part.
- Onglet « Points d'attention » de l'import : le compte est le nombre d'idées portant au moins un
  point.
- Case « Tout importer » de l'aperçu d'import : agit sur les lignes affichées (après filtres).
- Pas de mode sombre en V1 (le bloc `.dark` des styles reste en place, non branché).

## Sécurité

- Projet Supabase hébergé dans l'Union européenne (`eu-north-1`, Stockholm) : les données
  personnelles des auteurs d'idées restent dans l'UE.

- Aucun secret dans le dépôt : `.env.local` est ignoré, `.env.example` documente les variables.
- Seules les variables `BUN_PUBLIC_*` sont intégrées au code du navigateur.
- Le détail des règles est dans [CLAUDE.md](CLAUDE.md) §7.
