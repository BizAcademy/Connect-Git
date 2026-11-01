# Connecteur Sabito — Buzz Booster

## Périmètre métier

Le connecteur expose désormais **dix** opérations, dont
`admin_adjustment_status`, qui consulte uniquement les écritures
`wallet_transactions.type=admin_adjustment` du membre. Champs :
`movement_number` requis ; `movement_type` facultatif mais doit être
`admin_adjustment` s’il est fourni. Montant, sens, devise et date sont lus
dans l’écriture existante ; aucune note interne ni identité du personnel
n’est renvoyée.

## Démarrage production et diagnostic

Le point d’entrée de l’API démarre le superviseur en production **et lorsque
Passenger lance directement le serveur sans NODE_ENV**. Les modes explicites
`development`, `test` et le proxy de preview ne le démarrent pas. Les commandes
`start` prennent désormais `production` par défaut, sans écraser un mode
explicitement fourni. Le bundle de déploiement exige Node.js **21 minimum**
(Node.js 22/24 conseillé).

Après le push et **Pull Now → Deploy Now → Restart Now**, exécuter dans le
Shell **du serveur Cybrancy**, depuis la racine du dépôt, avec les variables
serveur existantes disponibles dans ce processus :

```bash
node dist-deploy/api-server/scripts/check-sabito-connection.mjs
```

Ne pas exécuter une commande qui imprime l’environnement. La sonde ne demande
aucune tâche (`operations: []`), ne lit aucune donnée membre et ne journalise
ni l’URL, ni un en-tête, ni un corps de réponse. Elle contrôle :

- Node et configuration HTTPS ;
- authentification Basic : `HTTPS_AUTH_OK_NO_OPERATIONS` avec HTTP 200 ;
- connexion MySQL : `DATABASE_REACHABLE` ;
- accessibilité des colonnes nécessaires avec `SELECT ... LIMIT 0`.

Un échec conserve son étape et un code sûr, par exemple `ECONNREFUSED`,
`ETIMEDOUT`, `ER_ACCESS_DENIED_ERROR`, `ER_BAD_FIELD_ERROR` ou HTTP 401/403.
`CHECKS_OK_MEMBER_TEST_REQUIRED` ne signifie **pas** qu’une vérification métier
réelle a réussi.

Si une ancienne version affiche `MODULE_NOT_FOUND` pour
`thread-stream-worker.mjs` dans un chemin `/tmp/buzzbooster-sabito-push...`,
il s’agit d’un défaut du bundle de journalisation, pas d’une clé Sabito :
le diagnostic s’est interrompu avant de terminer ses vérifications.
Le build résout désormais les fichiers de journalisation depuis le dossier
réellement déployé, y compris pour les scripts dans `scripts/`.
Reconstruire avec la commande de push habituelle, puis Pull Now → Deploy Now →
Restart Now dans Cybrancy, avant de relancer `sabito:check`.

Le test de portabilité compile dans un dossier temporaire, copie le bundle,
supprime le dossier de compilation puis lance le diagnostic et le superviseur
sans aucune variable métier ni accès à une base réelle. Il couvre le mode
production, le mode sans `NODE_ENV`, les chemins avec espaces et un autre
dossier courant :

```bash
node --test artifacts/api-server/tests/api-bundle-relocation.test.mjs
```

### Processus persistant si l’hébergement met Passenger en veille

Un serveur HTTP suspendu par l’hébergeur ne peut pas garantir un connecteur
permanent. Si Cybrancy autorise un gestionnaire de processus toujours actif,
le fichier optionnel `ecosystem.sabito.config.cjs` lance le superviseur séparé,
sans lancer les scanners de paiements de l’API et sans contenir de secrets :

```bash
# Seulement si PM2 est déjà disponible et pris en charge sur cet hébergement :
pm2 start ecosystem.sabito.config.cjs
pm2 save
```

PM2 doit être lancé avec le même environnement serveur existant que l’application
(les variables de l’interface Passenger ne sont pas nécessairement héritées par
le Shell). Ne pas recopier de clés dans le fichier de configuration.
Le redémarrage après reboot exige aussi le service de démarrage PM2 du serveur :
`pm2 save` seul ne crée pas ce service. Sa configuration dépend des droits et
du gestionnaire d’hébergement ; elle ne peut pas être confirmée depuis Replit.

Après un déploiement ultérieur, si ce service dédié est utilisé :

```bash
pm2 restart ecosystem.sabito.config.cjs --update-env
```

Le verrou partagé MySQL conserve un seul consommateur actif même si les
superviseurs API et dédié coexistent. Le redémarrage couvre les sorties **et
les erreurs de création du processus enfant**, avec temporisation.
Les appels SDK sont bornés à 60 secondes et ne suivent pas de redirection.

Le consommateur Replit a été arrêté et son workflow local retiré :
l’aperçu ne doit pas prendre les tâches destinées à la production.

### Preuve métier après déploiement

1. Vérifier dans les logs `ready/DATABASE_READY`, puis `poll` HTTP 200.
2. Confirmer l’état connecté du canal dans l’administration Sabito.
3. Avec un membre autorisé, demander le statut d’un dépôt existant (Mobile Money
   et crypto selon disponibilité) et comparer avec son historique réel.
4. Vérifier les logs `verification` puis `delivery` réussie, sans identifiants
   ni données personnelles.
5. Avec ce même membre, utiliser une référence de transaction d’un autre membre :
   `not_found` / `forbidden`, sans détail de cette transaction.
6. Un essai ne doit pas modifier le solde, déclencher un crédit ou créer un
   nouveau paiement. Ne pas tester en initiant un paiement réel.

L’accès à Cybrancy et aux sessions membres n’étant pas disponible ici, ces preuves
ne doivent jamais être annoncées comme obtenues à partir des seules sondes.

Buzz Booster est une application SMM : dépôts, commandes de boost et parrainage.
Il n'existe pas d'activation de compte à vérifier par Sabito ni de service de
retrait. Les contrôles de session, de compte désactivé et de vérification e-mail
de l'authentification existante restent inchangés.

Le SDK officiel, conservé sans modification dans `artifacts/api-server/src/vendor/`,
fonctionne uniquement sur le serveur avec les variables existantes `SABITO_URL`,
`SABITO_CLIENT_ID`, `SABITO_CLIENT_SECRET` et MySQL. Node.js 21 minimum.
Ne jamais afficher leurs valeurs dans Git, les logs ou le navigateur.

## Neuf opérations raccordées

| Handler exact | Lecture réelle | Champs collectés |
|---|---|---|
| `deposit_status` | Dépôt Mobile Money ou crypto et écriture de crédit du membre | `deposit_number` et/ou `transaction_id` et/ou `phone_number` ; `country`, `payment_method` facultatifs |
| `order_status` | Commande du membre, puis action fournisseur `status` en lecture seule | `order_number` |
| `order_refund_status` | Commande, mouvement `refund` et demandes de remboursement ouvertes du membre | `order_number` |
| `deposit_bonus_status` | Bonus enregistré du dépôt et mouvements de dépôt/bonus | Même collecte que `deposit_status` |
| `referral_code` | Code existant dans le profil | Aucun |
| `referral_reward_status` | Récompense du membre en tant que parrain et son propre mouvement | `referral_number` si plusieurs récompenses correspondent |
| `referee_bonus_status` | Bonus du membre en tant que filleul et son propre mouvement | `referral_number` facultatif |
| `wallet_balance` | Solde local interne et solde USD du profil | Aucun |
| `wallet_movement_status` | Mouvement précis dans le journal du membre | `movement_number`, `movement_type` facultatif |
| `admin_adjustment_status` | Ajustement administrateur déjà inscrit dans le journal du membre, sans notes internes | `movement_number` ; type imposé `admin_adjustment` |

`account_activation` et `withdrawal_status` ne sont pas annoncés.
La liste des opérations du poller et celle autorisée dans les logs partagent
les mêmes constantes.

### Références et montants

Les références sont utilisées telles quelles, avec requêtes paramétrées et
contrôle d'appartenance. Aucune recherche globale par référence seule.
`deposit_number` correspond à l'identifiant local, l'ordre de paiement,
la référence de paiement ou celle du prestataire. `transaction_id` correspond
uniquement à une référence effectivement enregistrée dans cette colonne :
ne pas promettre une recherche de hash blockchain si le prestataire ne l'a
pas enregistré. Ne demander aucune clé privée ni phrase de récupération.

Un numéro de téléphone n'est pas une preuve de paiement. Plusieurs dépôts
correspondants donnent `error` avec demande de référence supplémentaire.
Quand plusieurs champs sont fournis, ils doivent désigner la même ligne.
`payment_method` correspond à `payments.method`, pas au libellé libre d'un opérateur.
Les ajustements administrateur ne sont pas considérés comme des dépôts.

Les montants retournés sont les unités monétaires enregistrées divisées par 100,
sans conversion. Le crédit effectivement enregistré est distinct du montant du
dépôt : le mouvement Mobile Money peut comprendre le bonus. Sa devise est celle
enregistrée dans le journal et n'est pas corrigée silencieusement.
Les soldes sont distincts : portefeuille local interne en XAF et USD, sans total
converti. Les montants invalides ou hors des entiers sûrs ne sont pas arrondis.

### Statuts et limites

- Dépôt : `pending`/`irregular` → catégorie `pending` ; `completed` →
  `confirmed` seulement avec date de crédit et écriture du membre ;
  `failed`/`rejected`/`canceled`/`cancelled`/`expired` → `failed`.
- Commande : `pending`/`processing` → `pending`, `completed` → `confirmed`,
  `partial`/`refunded` → `ok`, annulation/échec → `failed`.
  Le statut normalisé réel reste dans `data.statut`. Seule une quantité restante
  réellement retournée par le fournisseur est exposée. Aucune progression ni
  échéance n'est estimée. Le nom et la catégorie du service sont conservés ; il
  n'existe pas de colonne réseau social distincte, donc ce champ reste `null`.
- Remboursement : `confirmed` seulement avec crédit et montant concordants ;
  partiel si le montant enregistré est inférieur au prix payé.
  Une demande ouverte sans crédit donne `pending` ; sans crédit ni demande
  ouverte, `ok` avec « Aucun remboursement enregistré ». Les tickets actuels ne
  fournissent pas d'états structurés distincts « en cours » ou « refusé » :
  ne pas les déduire d'une fermeture ou d'une note interne.
- Bonus de dépôt : états enregistrés `credited`, `pending`, `not_eligible`.
  Un dépôt encore en attente avec le drapeau initial `not_eligible` ne prouve pas
  une décision définitive d'inéligibilité. Aucun seuil ni montant futur n'est promis.
- Récompenses : seul le montant de la propre récompense du membre est lu.
  Crédit confirmé uniquement avec date et écriture concordantes.
  Ni identité, ni paiement, ni coordonnées d'un filleul ne sont renvoyés.
- Mouvement : sept types existants autorisés (`deposit`, `order_debit`, `refund`,
  `deposit_bonus`, `referral_referrer_bonus`, `referral_referred_bonus`,
  `admin_adjustment`). Un ajustement expose un libellé générique, pas les notes
  ni l'identité du personnel.

Les états inconnus, incohérences, pannes, ambiguïtés et délais dépassés ne
produisent jamais une fausse confirmation. Tous les handlers sont protégés par
un délai et contrôlent l'expiration après chaque lecture. Le résultat `data`
est plat, limité à 32 propriétés scalaires et 2 000 caractères par chaîne.

## Processus persistant

L'API en `NODE_ENV=production` lance un superviseur qui crée le worker
`dist/scripts/sabito-worker.mjs`. Le redémarrage automatique applique un délai
de 2 à 60 secondes. SIGTERM/SIGINT et la disparition du parent arrêtent l'enfant.
Un verrou MySQL nommé élit un seul connecteur pour cette plateforme.
Le worker ne récupère aucun job tant que la base est inaccessible.

Cybrancy doit garder le processus Node actif en permanence. Le superviseur ne
peut pas compenser une mise en veille du parent. Si nécessaire, utiliser un
service permanent séparé `node dist/scripts/sabito-supervisor.mjs`, avec le
même environnement et sans deuxième poller actif.

Le statut SMM est lu via l'action `status` seulement, en HTTPS avec délai et
redirections refusées. Aucun appel à `syncOrderInternal`, qui peut rembourser.
Les lectures ne lancent aucun paiement, commande, crédit, remboursement, bonus
ou ajustement. Les codes de parrainage ne sont pas générés.

## Dashboard Sabito

La correspondance précise, les phrases et les textes proposés à valider se
trouvent dans `SABITO-INTENTIONS.md`. Ce fichier ne crée aucune intention.
Produit du widget : `buzzbooster`. Pas de `data-project-id` en mode membre.
Le paramétrage effectif du dashboard reste à réaliser par son administrateur.
Conserver la proposition de vérification et la confirmation oui/non avant
toute collecte privée. Un visiteur doit se connecter avant une consultation.

Si l'hébergeur définit une CSP, autoriser Sabito dans `script-src` et `frame-src`,
et ses connexions nécessaires dans `connect-src`, sans désactiver CSP/CORS.
Vérifier les origines exactes dans Sabito pour le mode membre et le visiteur.

## Tests et validation réelle

Depuis la racine du dépôt importé :

```sh
node --test artifacts/api-server/tests/sabito-backend.test.mjs artifacts/api-server/tests/sabito-diagnostics.test.mjs artifacts/api-server/tests/sabito-session.test.mjs artifacts/api-server/tests/sabito-visibility.test.mjs
pnpm --filter @workspace/api-server exec tsc --noEmit
pnpm --filter @workspace/api-server run build
```

Le diagnostic suivant vérifie uniquement HTTPS et l'authentification serveur,
sans réclamer d'opération métier (`operations: []`) :

```sh
NODE_ENV=production node artifacts/api-server/dist/scripts/check-sabito-connection.mjs
```

Les logs sont limités aux événements, noms d'opérations, catégories et codes
HTTP/erreurs non sensibles. Pas d'identité, référence privée, code ou secret.
Un HTTP 200 ou un canal connecté ne suffit pas à prouver les lectures métier.

Dans cet environnement, MySQL refuse la connexion depuis Replit
(`ECONNREFUSED`). La validation réelle reste à faire après déploiement manuel :
demande depuis un compte membre autorisé, comparaison avec ses données et
logs `verification` puis `delivery` HTTP 2xx. Tester aussi le refus d'une
référence d'un second compte de test autorisé.

L'utilisateur pousse lui-même, puis Pull Now → Deploy Now → Restart Now
dans Cybrancy. Aucune migration SQL nouvelle n'est nécessaire.
