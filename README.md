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
   - *Site URL* : l'URL de production (ex. `https://<app>.vercel.app`) ;
   - *Redirect URLs* : `http://localhost:3000/auth/callback` et
     `https://<app>.vercel.app/auth/callback` (ajouter aussi le motif des previews Vercel si besoin).
4. **Authentication → Emails → Magic Link** : le modèle doit contenir à la fois le lien
   `{{ .ConfirmationURL }}` **et** le code `{{ .Token }}`. Exemple :

   ```html
   <h2>Connexion à Challenge Innovation</h2>
   <p><a href="{{ .ConfirmationURL }}">Se connecter</a></p>
   <p>Ou saisissez ce code : <strong>{{ .Token }}</strong></p>
   <p>Ce lien et ce code sont valables une heure. Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.</p>
   ```
5. **Authentication → Users → Invite user** : inviter chaque évaluateur.
6. Copier l'URL du projet et la **clé publishable** (Project Settings → API Keys) dans
   `.env.local`. Ne jamais utiliser la clé secrète côté navigateur : l'application refuse
   de démarrer si c'est le cas.

## Sécurité

- Aucun secret dans le dépôt : `.env.local` est ignoré, `.env.example` documente les variables.
- Seules les variables `BUN_PUBLIC_*` sont intégrées au code du navigateur.
- Le détail des règles est dans [CLAUDE.md](CLAUDE.md) §7.
