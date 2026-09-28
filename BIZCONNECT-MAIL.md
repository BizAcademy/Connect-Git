# E-mails BizConnect — BUZZ BOOSTER

## Événements

- Inscription : code OTP à 6 chiffres envoyé par e-mail. L'adresse doit être
  confirmée dans les 10 minutes avant la première connexion. Le compte est
  créé sans session ; une nouvelle demande de code est possible sous limite
  de fréquence. Les comptes existants avant la migration restent utilisables.
- Mot de passe oublié : lien à usage unique, valable 30 minutes.
- Dépôt effectivement crédité : confirmation du montant et de la référence.
  Les crédits FCFA et USD sont couverts. Pas d'e-mail pour un paiement
  en attente, irrégulier, déjà crédité, ni pour un versement de bonus seul.
- Aucun changement au fournisseur de paiement ni à l'authentification MySQL existante.

## Activation dans Cybrancy

1. Exécuter dans la base MySQL/MariaDB existante, dans cet ordre :
   - `migrations/mysql/008_notification_outbox.sql`
   - `migrations/mysql/009_password_reset.sql`
   - `migrations/mysql/010_signup_email_verification.sql`
   Ces migrations sont additives et peuvent être réexécutées.
2. Construire et pousser le code depuis Replit, puis Pull et Deploy dans Cybrancy.
3. Renseigner dans les variables serveur de l'application Node.js :

   | Variable | Valeur |
   | --- | --- |
   | `BCA_NOTIFICATION_CLIENT_ID` | Identifiant donné par l'admin BizConnect |
   | `BCA_NOTIFICATION_CLIENT_SECRET` | Secret donné par l'admin BizConnect |
   | `BCA_NOTIFICATION_ENDPOINT` | `https://api.bizconnectacademy.com/api/v2/external/notifications/email` |
   | `BCA_NOTIFICATION_APP_URL` | URL HTTPS publique réelle de BUZZ BOOSTER, sans paramètres ni fragment |

   Ne pas mettre ces identifiants dans GitHub, dans le frontend ou dans des
   variables `VITE_*`. Les anciens noms `BIZCONNECT_CLIENT_ID` et
   `BIZCONNECT_CLIENT_SECRET` restent compatibles uniquement en paire ; les
   nouveaux noms sont prioritaires et les deux paires ne sont jamais mélangées.
4. Faire Restart dans Cybrancy.

Appliquer les migrations **avant d'activer les identifiants** : une inscription
ou un crédit doit pouvoir inscrire son e-mail dans la même transaction MySQL.
Une panne HTTP du fournisseur ne bloque pas le crédit ; une table de file
manquante ferait échouer la transaction plutôt que perdre silencieusement
la notification.

Sans identifiants, les dépôts continuent normalement sans e-mail, mais
l'inscription et la récupération sont indisponibles : il est interdit de
créer un nouveau compte sans possibilité de confirmer son adresse. Une
configuration partielle est refusée au démarrage.

## Fonctionnement et sécurité

Les destinataires viennent de `users.email` et `profiles.username`, jamais d'un
identifiant utilisateur BizConnect. Le fournisseur reçoit uniquement les champs
de son contrat, sans `platform_name` ni `support_email`.

La file persistante est enregistrée **avant le commit** de l'opération métier.
Le worker l'examine toutes les 5 secondes. Il fait les appels hors des requêtes
utilisateur, avec un délai HTTP maximal de 10 secondes. Il reprend les tâches
abandonnées après expiration de leur verrou de 90 secondes.

Le corps du premier envoi et sa clé restent identiques entre les tentatives,
même après un redémarrage ou un changement du profil. Les réponses 202 et
200 avec `duplicate=true` sont acceptées. Seules les erreurs réseau et 5xx
sont réessayées, avec attente croissante plafonnée à 5 minutes et au maximum
8 tentatives après erreurs. Les erreurs 401, 409, 422 et autres 4xx ne le sont pas.
Le `delivery_id` est enregistré lorsqu'il est fourni ; « sent » dans la file
signifie **accepté par BizConnect**, pas preuve de réception dans la boîte mail.

Les contenus en attente, y compris les liens de récupération, sont chiffrés
AES-256-GCM avec une clé dérivée du secret BizConnect côté serveur. Ils sont
effacés après acceptation, expiration ou échec définitif. Ne pas changer le
secret avec des messages encore en attente : les anciennes données ne seraient
plus déchiffrables. Arrêter la production de nouveaux e-mails et laisser vider
la file avant une rotation planifiée. En cas de révocation urgente, faire passer
la sécurité en priorité ; les demandes de récupération concernées devront être
renouvelées.

Les tokens de récupération sont aléatoires (256 bits), hachés dans leur table,
à usage unique et expirent après 30 minutes. Le token du lien est dans le
fragment URL, retiré de l'adresse par l'interface. Le changement de mot de passe
révoque les sessions et invalide tous les autres tokens de l'utilisateur.
Les réponses aux demandes pour un compte connu ou inconnu sont identiques.
Un délai persistant de 5 minutes par adresse et d'une minute par IP limite
les abus. Les limites de l'API s'appliquent également.

Les OTP d'inscription sont à usage unique, expirent après 10 minutes et sont
limités à 5 essais. Seule leur empreinte HMAC est enregistrée en base. Le
renvoi respecte un délai d'une minute et un plafond de 5 codes par heure et
par compte. Les codes eux-mêmes restent chiffrés dans la file avant l'envoi.
Un utilisateur non confirmé ne reçoit pas de cookie de session et ne peut
pas se connecter, même avec le bon mot de passe.

Une réponse HTTP **401 de BizConnect** signifie que ses identifiants sont
invalides ou inactifs. Corriger la configuration côté fournisseur puis
demander un nouveau code ; un message définitivement refusé n'est pas
réexpédié automatiquement.

## Surveillance et tests

```sql
SELECT status, COUNT(*) AS total
FROM notification_outbox
GROUP BY status;

SELECT event_key, attempts, last_http_status, created_at, finished_at
FROM notification_outbox
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 50;
```

Ne pas afficher le contenu des e-mails ni les identifiants dans les logs.
Les échecs définitifs doivent être examinés ; ils ne sont pas réexpédiés
automatiquement après correction d'une clé.

```bash
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/bizpanel run typecheck
node --test artifacts/api-server/tests/*.test.mjs
```

Les tests automatisés utilisent des doubles MySQL/fournisseur et n'envoient
aucun véritable e-mail. La preview Replit utilise une base MariaDB locale
isolée et permet de tester les nouvelles routes sans écrire en production.
La livraison réelle reste à vérifier avec des identifiants BizConnect actifs
et une nouvelle adresse de test.