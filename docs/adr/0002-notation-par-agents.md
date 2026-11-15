# ADR 0002 — Notation des idées par une équipe d'agents IA (OpenRouter)

- **Statut** : acceptée
- **Date** : 2026-11-15

## Contexte

L'évaluateur doit noter chaque idée sur quatre critères (impact, faisabilité, alignement
stratégique, caractère innovant) de façon cohérente et argumentée, comme le ferait un cabinet de
conseil pour un groupe industriel d'environ 4 000 salariés. Demandes explicites : des agents
spécialisés et un orchestrateur, une vraie recherche sur internet (rapports, études de marché,
entreprises cotées), une explication détaillée de chaque note, et l'estimation logique des données
manquantes.

## Décision

1. **Équipe d'agents** (`src/server/evaluateIdea.ts`) :
   - **analyste** : estime les champs absents (budget en fourchette, bénéfices, thème…) avec
     méthode, hypothèses, confiance et sources ; ces estimations sont stockées à part
     (`evaluations.estimates`) et **ne remplacent jamais** les données importées ;
   - **4 consultants**, un par critère, en parallèle, avec recherche web : note 1–5,
     sous-critères notés, arguments pour/contre, hypothèses, données manquantes, confiance, sources ;
   - **associé senior** (orchestrateur) : synthèse pour le jury, incohérences, recommandation
     (retenir / à discuter / écarter), prochaines étapes. Il ne modifie pas les notes : la note
     globale est une moyenne pondérée **calculée par le code** (`weightedAverage`).
2. **OpenRouter** comme passerelle (au lieu de l'API Claude seule) : un modèle adapté par rôle,
   configurable sans changer le code ; recherche web intégrée (plugin `web`) dont les pages
   trouvées reviennent en annotations. Par défaut : `anthropic/claude-haiku-5.5` (analyste,
   consultants) et `anthropic/claude-sonnet-5.5` (associé). Coût estimé : ~1 $ pour 40 idées.
3. **Sources vérifiables** : une source citée par un agent n'est conservée que si son adresse
   figure dans les résultats réels de sa recherche (`checkSources`). Les autres sont écartées et
   comptées. Aucune source inventée ne peut s'afficher.
4. **Sortie structurée** validée par zod ; une réponse hors schéma est redemandée une fois, puis
   l'évaluation échoue. Aucune note n'est jamais inventée ou « réparée ».
5. **Confidentialité** : seuls les champs de l'idée et le contexte du client sont envoyés, jamais
   l'auteur ; fournisseurs qui conservent ou réutilisent les données exclus
   (`provider.data_collection = "deny"`) ; contenu de l'idée délimité et déclaré comme donnée
   (protection contre l'injection de consignes).
6. **Intégrité** : les résultats des agents (`evaluations`, `criterion_assessments`) ne sont
   écrits que par le serveur, avec la clé secrète Supabase ; le navigateur n'a qu'un droit de
   lecture. L'idée est d'abord lue **avec le jeton de l'utilisateur** (RLS) : un non-membre ne
   peut rien évaluer. La note finale (`scores`) est uniquement humaine.
7. **Coût maîtrisé** : réutilisation d'une évaluation identique (même empreinte de contenu, même
   version des consignes, mêmes modèles) sauf demande explicite ; un seul passage en cours par
   idée (index unique en base).

### Révision du 2026-11-15 : notation automatique, contexte supposé

La notation doit démarrer sans aucun renseignement de l'utilisateur. Sans contexte saisi pour le
challenge, les agents reçoivent un **contexte client supposé** (`DEFAULT_CLIENT_CONTEXT`, cité
dans le README), explicitement marqué comme hypothèse non confirmée. Une idée jamais évaluée est
notée dès l'ouverture de sa fiche ; un bouton évalue tout le challenge (deux idées à la fois,
arrêt automatique sur erreur de clé ou de crédit). Pas de relance automatique après un échec.
Étape suivante prévue : un dialogue avec l'IA pour expliquer une note et intégrer des
informations fournies par l'utilisateur.

### Révision du 2026-11-15 : Z.ai (GLM) et limitation de débit

- **Fournisseur au choix** (`LLM_PROVIDER`) : Z.ai (modèles GLM, `glm-5.2` par défaut, API
  compatible OpenAI, recherche web via l'outil `web_search` dont les résultats servent à vérifier
  les sources) ou OpenRouter. Z.ai ne propose que le mode JSON sans schéma imposé : le schéma est
  décrit dans les consignes et la réponse reste validée par zod.
- **Limitation de débit** vers le fournisseur (concurrence, appels par minute, espacement, pause
  générale sur saturation avec `Retry-After` ou attente exponentielle) et **quota par
  utilisateur** (évaluations par heure, compté en base).
- **Exécution en arrière-plan** : la file d'attente du limiteur peut allonger une évaluation
  au-delà du délai d'une requête HTTP ; le serveur répond donc 202 et la page suit l'avancement.

### Révision du 2026-11-15 : discussion avec l'IA et réévaluation

- `POST /api/idea-chat` : conversation avec l'associé senior sur une idée (explication, apport
  d'informations, comparaison avec des idées citées par `@IDENTIFIANT`, résolues dans le même
  challenge avec le jeton de l'utilisateur). Messages conservés dans `idea_chat_messages`,
  écrits par le serveur seul (lecture seule pour le navigateur).
- Réévaluation « avec ces informations » : les messages de l'évaluateur non encore utilisés sont
  transmis aux agents (bloc `<informations_evaluateur>`, déclaré comme donnée) et enregistrés
  dans `evaluations.evaluator_notes` ; les messages sont rattachés à l'évaluation produite.
  `PROMPT_VERSION` passe à 1.1.

## Conséquences

- Nouvelle clé serveur : `SUPABASE_SECRET_KEY` (jamais dans le navigateur ; l'application refuse
  déjà de démarrer si une clé secrète est exposée côté client).
- L'analyse de marché dépend de la qualité de la recherche web ; les agents doivent signaler une
  confiance faible quand les sources manquent. Les données boursières ne viennent que de pages
  publiques trouvées par la recherche (pas d'API financière en V1).
- Une évaluation prend 1 à 3 minutes ; l'appel est synchrone en V1 (pas de file d'attente).
  La notation par lot de toutes les idées viendra ensuite.
- Le passage par OpenRouter ajoute un intermédiaire : sa politique de données doit être revue
  avant usage sur des données réelles d'un client.

## Alternatives écartées

- **Un seul appel pour les quatre critères** : moins cher, mais critères qui se contaminent et
  explications moins approfondies.
- **Modèles gratuits** : quotas bas, qualité inégale et conservation possible des données ; à
  réserver au développement avec des données fictives.
- **Note globale décidée par l'associé** : non reproductible ; la moyenne pondérée est explicable.
