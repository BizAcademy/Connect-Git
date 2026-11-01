# Connecteur Sabito — Buzz Booster

## Périmètre métier

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
node --test artifacts/api-server/tests/sabito-backend.test.mjs artifacts/api-server/tests/sabito-session.test.mjs artifacts/api-server/tests/sabito-visibility.test.mjs
pnpm --filter @workspace/api-server run typecheck
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
