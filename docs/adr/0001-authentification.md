# ADR 0001 — Authentification sans mot de passe, sur invitation

- **Statut** : acceptée
- **Date** : 2026-11-15

## Contexte

Les utilisateurs sont des consultants non techniques, peu nombreux, invités par un
administrateur. L'application manipule des données personnelles de salariés d'un client :
l'accès doit être restreint, simple et sans mot de passe à gérer.

## Décision

1. **Supabase Auth, connexion par e-mail sans mot de passe** : un même e-mail contient un
   **lien magique** et un **code à usage unique**.
   - Le code couvre les cas où le lien échoue : ouverture dans un autre navigateur (PKCE),
     antivirus de messagerie qui « pré-clique » les liens et consomment le jeton.
2. **Flux PKCE** (`flowType: "pkce"`) ; échange du code fait explicitement sur
   `/auth/callback` (`detectSessionInUrl: false`) pour afficher des erreurs précises.
3. **Sur invitation uniquement** : `shouldCreateUser: false` côté client **et** inscriptions
   désactivées côté Supabase. Le client seul ne suffit pas : c'est le réglage serveur qui fait foi.
4. **Anti-énumération** : qu'une adresse soit autorisée ou non, l'écran affiche le même message
   (« Si l'adresse est autorisée, vous allez recevoir un e-mail »).
5. **Redirections sûres** : le paramètre `next` ne peut désigner qu'un chemin interne
   (`safeRedirectPath`, testé contre les redirections ouvertes).
6. **Garde-fou de configuration** : l'application refuse de démarrer si une clé secrète
   (`sb_secret_…` ou JWT `service_role`) est fournie au navigateur.
7. La sécurité des données ne repose **pas** sur le front : la RLS en base reste la barrière
   réelle (tables à venir).

## Conséquences

- Session stockée dans le `localStorage` (comportement standard de supabase-js pour une SPA
  sans serveur) : exposée en cas de XSS. Parades : pas de HTML brut issu des données, jetons
  courts et rafraîchis, CSP stricte à ajouter au déploiement (`vercel.json`).
- Dépendance au délivrabilité e-mail : SMTP personnalisé recommandé en production (le SMTP par
  défaut de Supabase est limité en volume).
- Gestion des comptes (invitation, retrait) faite dans le tableau de bord Supabase en V1.

## Alternatives écartées

- **Mot de passe** : charge de gestion pour l'utilisateur, risques de réutilisation.
- **SSO d'entreprise** : pertinent à terme (V2), disproportionné pour la V1.
- **Cookies httpOnly via un serveur** : plus robuste face au XSS mais impose un backend de
  session ; à reconsidérer si l'application s'ouvre à des utilisateurs externes.
