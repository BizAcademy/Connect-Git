# Widget Sabito AI — Buzz Booster

Le frontend utilise uniquement le chargeur officiel Sabito. Aucune réponse,
référence, question suggérée ou interface de chat n'est reproduite ici.

## Visiteurs et membres

- Visiteur : projet public `b5e20880-c403-412e-a24e-914851872294`,
  produit `buzzbooster`.
- Membre : aucun `data-project-id`. Le fournisseur de session appelle uniquement
  `POST /api/sabito/session` sur Buzz Booster avec la session cookie existante,
  le signal d'annulation, et `X-CSRF-Token` si la méta `csrf-token` existe.
- Le fournisseur renvoie la `Response` originale au chargeur. Il n'invente pas
  d'identité et n'enregistre aucun jeton Sabito.
- Le cookie Buzz Booster ne doit jamais être transmis au domaine Sabito.

## Isolation des comptes

Le widget est chargé une fois par document, hors des routes et de Suspense.
Une navigation interne ne crée pas un second widget.

La déconnexion et les erreurs d'authentification ferment la session Sabito et
retirent immédiatement son iframe. Au changement d'identité, le document est
rechargé : le chargeur actuel capture son mode au démarrage et ne propose pas de
méthode `destroy`. Cela évite de réutiliser le contexte visiteur ou les écouteurs
d'un compte précédent. Un canal inter-onglets transporte uniquement des signaux
d'invalidation, jamais d'identité, de jeton ou de conversation.

## Création des sessions membres

La route `POST /api/sabito/session` est maintenant implémentée dans
`artifacts/api-server/src/routes/sabito.ts`.

- Le middleware `requireUser` existant vérifie le cookie `bb_session`, la présence
  du membre, l'expiration et la révocation de la session.
- La protection CSRF exige un `Origin` identique à celui de la requête serveur,
  refuse `Sec-Fetch-Site: cross-site`, puis exige le type `application/json` et
  le corps vide `{}`. Aucun identifiant ni nom fourni par le navigateur n'est
  accepté. Une requête non authentifiée reçoit 401.
- La route limite les appels à 20 par minute et par membre, dans chaque processus
  serveur. L'échange est limité à 10 secondes et annulé si le navigateur se ferme.
- `src/lib/sabito-session.ts` appelle `/v1/auth/token` avec l'authentification
  Basic serveur et uniquement l'identifiant vérifié. Aucun cookie Buzz Booster
  ni en-tête `Origin` n'est transmis à Sabito.
- La réponse doit avoir `success: true`, une identité `platform_user`, le même
  identifiant, un jeton non vide, un chemin socket local et une durée entière
  entre 1 et 900 secondes.
- Le navigateur reçoit uniquement `access_token`, `expires_in`, `socket_path`,
  `external_user_id`, sans enveloppe, avec `Cache-Control: no-store` et
  `Pragma: no-cache`. Aucun jeton n'est persisté côté Buzz Booster.
- Une erreur des identifiants de plateforme Sabito n'est pas transformée en
  401 local : elle ne doit pas déconnecter à tort le membre de Buzz Booster.
  Les messages d'erreur ne contiennent ni réponse distante ni secret.

Les variables privées `SABITO_CLIENT_ID` et `SABITO_CLIENT_SECRET` doivent être
configurées dans le serveur Cybrancy également. `SABITO_URL` est facultative et
vaut par défaut `https://sabito.bizconnectacademy.com`. Une valeur explicite
incorrecte est refusée ; elle ne doit contenir qu'une origine HTTPS.

Le module `startSabitoBackend` fourni concerne les vérifications métier :
il n'est pas nécessaire à la création de session. Aucun worker d'activation de
compte, de dépôt ou de parrainage n'a été démarré. Aucun changement SQL n'est requis.

## Aperçu et publication manuelle

Les origines Buzz Booster et de l'aperçu doivent être autorisées côté Sabito.
Le proxy Replit actuel utilise l'API en ligne : un nouveau backend local ne
sera pas exécuté avant son déploiement manuel dans Cybrancy.
Une réponse 404 reste donc attendue dans l'aperçu tant que cette nouvelle route
n'a pas été publiée par l'utilisateur.

Pour cette route seulement, le proxy de développement vérifie l'origine exacte
de l'aperçu avant de la remplacer par celle de l'API distante pour le contrôle
CSRF du serveur. Une origine externe ou absente est refusée. Ce proxy reste hors
du dépôt applicatif exporté et n'est pas publié dans Cybrancy.

La vérification publique du widget avec l'origine de l'aperçu a renvoyé HTTP 403
et la politique `frame-ancestors 'self' https://buzzbooster.site`. Il faut
autoriser l'origine exacte de l'aperçu côté Sabito, ainsi que les éventuelles
origines parentes requises pour son intégration dans Replit, sans ouvrir cette
politique à tous les sites. Le domaine de production est déjà autorisé.

## Vérifications

Les tests `artifacts/api-server/tests/sabito-session.test.mjs` utilisent uniquement
une authentification et un serveur Sabito simulés, sans base distante ni secret
réel. Ils couvrent le contrat d'échange, les identités invalides, les durées,
la révocation, l'origine, la falsification de l'identité, les renouvellements,
la limitation des appels et la confidentialité des erreurs.

Les vérifications navigateur précédentes ont couvert le chargement unique, le mode visiteur,
les attributs du mode membre, la fermeture, le changement de compte et une
expiration de session simulée. Aucune vraie session membre n'a été créée.
Une vraie question, sa réponse approuvée et ses questions de suivi restent à
vérifier après publication du backend et autorisation de l'origine.

Le contrat a été ajouté à `lib/api-spec/openapi.yaml`. La régénération des clients
a été bloquée dans cet environnement par le téléchargement d'`orval` (HTTP 403).
La route et le widget ne dépendent pas de ces nouveaux clients : le fournisseur
du widget utilise intentionnellement une `Response` fetch native.
