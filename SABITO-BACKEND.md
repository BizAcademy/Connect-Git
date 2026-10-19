# Connecteur serveur Sabito

## Périmètre

SDK officiel téléchargé depuis
`https://sabito.bizconnectacademy.com/integrations/sabito-backend.mjs`,
conservé sans modification dans `artifacts/api-server/src/vendor/`.
Le SDK ne démarre jamais depuis le navigateur ni depuis une requête HTTP.

Variables privées du serveur : `SABITO_URL`, `SABITO_CLIENT_ID`,
`SABITO_CLIENT_SECRET` et les variables MySQL existantes. Aucune nouvelle clé.
Ne jamais mettre leurs valeurs dans Git, une commande partagée, le frontend ou
les logs. Le runtime du worker exige Node 21 ou ultérieur.

## Processus persistant et supervision

Le démarrage de l'API en `NODE_ENV=production` lance un superviseur qui crée un
processus enfant dédié `dist/scripts/sabito-worker.mjs`. Le superviseur le
redémarre automatiquement en cas de sortie inattendue, avec un délai progressif
de 2 à 60 secondes. Les arrêts SIGTERM/SIGINT arrêtent aussi l'enfant.
Le worker s'arrête si son parent disparaît.

Un verrou MySQL nommé élit un seul connecteur pour cette plateforme, même si
plusieurs processus HTTP démarrent. Le verrou est libéré à la fermeture ou à la
perte de connexion, sans modification des données métier.

Le worker exige une base accessible avant de récupérer les jobs Sabito. Il ne
doit pas transformer une panne MySQL connue en faux contrôles métier.

L'hébergement Cybrancy doit conserver son processus Node actif en permanence
(mode « always on » / absence de mise en veille Passenger). Le superviseur
interne ne peut pas fonctionner si l'hébergeur arrête le processus parent.
Si l'API ne peut pas être gardée active, utiliser un service Node permanent
séparé exécutant `node dist/scripts/sabito-supervisor.mjs`, avec le même
environnement et un gestionnaire de services avec redémarrage automatique.
Ne pas lancer un exemplaire supplémentaire via cron à chaque minute.

## Opérations annoncées

- `account_activation` : état réel de `users`, tenant compte de la désactivation,
  de la vérification e-mail et du rôle administrateur comme l'authentification.
  Cette fonction ne crée ni n'active de compte.
- `deposit_status` : recherche dans le vrai service de dépôts `payments`.
  Toute référence est contrainte par `user_id=job.external_user_id` dans la
  requête paramétrée. Si les deux références sont fournies, elles doivent
  désigner la même ligne. Aucun dépôt « le plus récent » n'est deviné.
  Une confirmation exige `status=completed` ET `credited_at` renseigné.
  Les états inconnus/contradictoires ou résultats ambigus donnent `error`.
  Aucune tentative de synchronisation ou de crédit financier.
- `referral_code` : seul le code déjà enregistré dans le profil du membre est
  retourné. Pas de génération, de mise à jour ni de ligne de profil complète.

Un membre désactivé/non vérifié ne peut pas consulter les dépôts ou parrainages.
Toutes les requêtes métier sont des SELECT paramétrés avec délai maximum.
Les jobs expirés, annulés ou sans identité membre valable sont refusés.
Les seules sorties sont les statuts autorisés, et le code pour `referral_code`.

**Aucun service/table de retraits n'existe dans ce dépôt.** Ne pas configurer
une intention `withdrawal_status` comme opération vérifiable sur cette
plateforme tant qu'un vrai service de retraits n'a pas été identifié et raccordé.
Ne pas substituer un dépôt ou un remboursement à un retrait.

## Contrôles et diagnostic sans secrets

Tests locaux sans données réelles :

```sh
node --test artifacts/api-server/tests/sabito-backend.test.mjs
```

Dans le dossier API compilé sur le serveur :

```sh
NODE_ENV=production node dist/scripts/check-sabito-connection.mjs
```

Ce diagnostic envoie POST `/v1/backend/jobs/poll` via HTTPS avec la même
authentification Basic que le SDK et `operations: []`. Il ne vérifie aucun
compte et ne traite aucune opération métier. Un code HTTP 200 et une liste de
jobs vide prouvent seulement la connectivité et l'authentification.
401 : identifiants rejetés ; 403 : accès refusé ; 404 : route SDK non publiée ;
429 : limitation ; absence de réponse : réseau/TLS. Les corps d'erreur distants
et les valeurs d'environnement ne sont jamais journalisés.

Les logs supervisés contiennent uniquement des événements opérationnels :
`ready` (base accessible), `poll` (HTTP), `verification` (opération/statut),
`delivery` (HTTP de remise du résultat), ou erreurs génériques.
Pas de membre, référence de transaction, code de parrainage, jeton ni secret.
Un événement `ready` ou un canal connecté ne prouve pas une vérification.
Un `verification: error` n'est jamais une vérification réussie.

## Validation réelle obligatoire

1. L'utilisateur pousse avec le script fourni puis fait lui-même
   Pull → Deploy → Restart dans Cybrancy.
2. Confirmer `poll` HTTP 200 et « canal connecté » dans Sabito.
3. Avec son compte membre autorisé, demander dans le chat son propre code de
   parrainage, puis le statut d'un dépôt de test lui appartenant.
4. Vérifier que la réponse correspond aux données réelles et que les logs montrent
   l'opération, le bon statut et une remise `delivery` HTTP 2xx.
5. Pour les contrôles négatifs, utiliser deux comptes de test autorisés :
   la référence du compte B demandée par A ne doit rien révéler ni être confirmée.
6. Ne pas qualifier le raccordement de terminé avant ces vérifications.

L'aperçu HTTP Replit utilise l'API en ligne. Son workflow connecteur séparé est
indépendant et peut être arrêté après validation pour laisser la place au serveur
Cybrancy (le verrou empêche leur exécution simultanée).

Lors du raccordement, MySQL refusait la connexion depuis Replit
(`ECONNREFUSED`). Aucun vrai contrôle membre n'a donc été revendiqué.
La sonde HTTPS authentifiée a, elle, reçu HTTP 200 avec une liste de jobs vide.
Le workflow Replit du superviseur redémarre son enfant en échec mais ne récupère
aucun job tant que MySQL est inaccessible.
Aucune migration ni requête SQL manuelle n'est nécessaire.
