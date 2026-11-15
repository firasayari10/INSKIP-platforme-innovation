# Plan de déploiement sur Vercel

Résumé rapide : [README § 7](../README.md#7-déploiement-sur-vercel). Ce document détaille chaque
étape, la recette et le retour arrière.

## 1. Prérequis

| Élément | Pourquoi | État attendu |
|---|---|---|
| Clé d'IA de **production** (Z.ai API standard ou OpenRouter) | La clé Coding Plan n'a pas de recherche web et des limites basses | Crédit disponible, plafond de dépense fixé |
| Barème réel `AI_PRICES_EUR_PER_MILLION` | Les crédits de 5 €/mois en dépendent | Tarif de l'offre souscrite, en euros par million de jetons |
| SMTP dans Supabase (ex. Brevo) | Liens de connexion et invitations fiables, modèles d'e-mail modifiables | Expéditeur vérifié, modèles du README § 8 collés |
| Upstash Redis, région UE | Limites de débit partagées entre instances ; obligatoire en production | Base créée, URL + jeton REST |
| Migrations appliquées | Le schéma distant doit correspondre au code | `bunx supabase migration list --linked` sans écart |
| CI verte sur `main` | Types, tests et build validés | Dernier run GitHub Actions en succès |

## 2. Relier le projet

```bash
bunx vercel login
bunx vercel link
```

Réglages du projet (Settings) :
- **Framework Preset** : *Other* (le build est décrit dans `vercel.json`).
- **Functions → Region** : `fra1` (UE, proche de Supabase `eu-north-1`).
- `vercel.json` fixe : `bun install --frozen-lockfile`, `bun run build`, sortie `dist/`,
  fonctions `api/*.ts` (300 s max), réécriture SPA, en-têtes de sécurité (CSP, HSTS,
  `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`).

## 3. Variables d'environnement

À saisir dans *Settings → Environment Variables* (Production et Preview). **Jamais** dans le
dépôt ; `.env.local` reste local.

| Variable | Côté | Obligatoire | Remarque |
|---|---|---|---|
| `BUN_PUBLIC_SUPABASE_URL` | navigateur | oui | Publique par nature |
| `BUN_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | navigateur | oui | Clé *publishable*, protégée par la RLS |
| `SUPABASE_URL` | serveur | oui | |
| `SUPABASE_PUBLISHABLE_KEY` | serveur | oui | |
| `SUPABASE_SECRET_KEY` | serveur | oui | **Secret** ; jamais en `BUN_PUBLIC_` (l'application refuse de démarrer sinon) |
| `LLM_PROVIDER` | serveur | oui | `zai` ou `openrouter` |
| `ZAI_API_KEY` ou `OPENROUTER_API_KEY` | serveur | oui | **Secret** |
| `AI_PRICES_EUR_PER_MILLION` | serveur | oui | Barème réel |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | serveur | oui | **Secret** pour le jeton |
| `APP_URL` | serveur | oui | `https://<votre-domaine>` |
| `ZAI_BASE_URL` | serveur | **non** | Ne pas définir : point d'entrée standard en production |
| `LLM_MAX_CONCURRENT`, `LLM_REQUESTS_PER_MINUTE`, `EVALUATIONS_PER_HOUR`… | serveur | non | Valeurs par défaut raisonnables (voir `.env.example`) |

Le build de la prévisualisation embarque les `BUN_PUBLIC_*` : après un changement de ces
variables, **redéployer**.

## 4. Base de données

```bash
bunx supabase migration list --linked   # écart éventuel
bunx supabase db push --remote          # seulement s'il reste des migrations
```

## 5. Supabase : domaine et e-mails

*Authentication → URL Configuration* :
- *Site URL* : `https://<votre-domaine>`
- *Redirect URLs* : `https://<votre-domaine>/auth/callback` (et l'URL de preview si besoin,
  ex. `https://*-<équipe>.vercel.app/auth/callback`)

*Authentication → Emails* : SMTP + modèles du README § 8.

## 6. Prévisualisation et recette

```bash
bunx vercel
```

| # | Vérification | Attendu |
|---|---|---|
| 1 | Connexion par lien et par code | Arrivée sur la liste des challenges |
| 2 | Invitation d'un utilisateur | E-mail reçu, compte créé |
| 3 | Import de `tests/fixtures/idees_hexavia.csv` | Rapport d'anomalies, idées visibles |
| 4 | Évaluation d'une idée | Notes + justifications + sources ; crédit 🪙 diminué |
| 5 | Discussion ✨ avec `@IDEA-xxx` | Réponse contextualisée |
| 6 | Rapport pour le jury → PDF | 8 idées, aucune donnée d'auteur |
| 7 | En-têtes de sécurité | Présents (commande ci-dessous) |
| 8 | Supabase *Advisors → Security* | Aucun nouvel avertissement |

```bash
curl -sI https://<url-de-preview>/ | grep -iE "content-security|strict-transport|x-frame"
```

## 7. Mise en production

```bash
bunx vercel --prod
```

Puis refaire rapidement les points 1, 4 et 6 de la recette sur le domaine final.

## 8. Retour arrière

```bash
bunx vercel rollback          # revient au déploiement précédent
```

Les migrations ne se défont pas automatiquement : une correction de schéma passe par une
nouvelle migration.

## 9. Points ouverts

- SMTP à configurer (bloque invitations et modèles d'e-mail personnalisés).
- Clé d'IA de production et barème réel à fournir.
- Domaine personnalisé éventuel (sinon `*.vercel.app`).
