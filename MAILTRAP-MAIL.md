# E-mails Mailtrap — BUZZ BOOSTER

Les codes OTP d'inscription, liens de réinitialisation et confirmations de dépôt
passent par **Mailtrap Email Sending, flux Transactional**. Le Sandbox Mailtrap
intercepte les messages et ne permet pas de recevoir de vrais codes.

## Configuration

1. Dans Mailtrap, vérifier le domaine d'envoi dans **Email API/SMTP → Sending Setup**.
2. Créer un jeton API autorisé pour l'envoi depuis ce domaine dans **API Tokens**.
3. Renseigner dans les secrets/variables du serveur Node.js (jamais dans le frontend
   ni dans Git) :

   | Nom | Valeur |
   | --- | --- |
   | `MAILTRAP_API_TOKEN` | Jeton API du domaine vérifié, secret |
   | `MAILTRAP_FROM_EMAIL` | Adresse expéditrice sur le domaine vérifié |
   | `MAILTRAP_FROM_NAME` | Nom affiché, facultatif (défaut : BUZZ BOOSTER) |
   | `NOTIFICATION_APP_URL` | URL HTTPS publique réelle de BUZZ BOOSTER, sans paramètres ni fragment |

   `BCA_NOTIFICATION_APP_URL` reste reconnu uniquement comme ancien nom pour
   l'URL des liens de réinitialisation ; aucun identifiant ou endpoint BizConnect
   n'est utilisé pour l'envoi. Renseigner les mêmes paramètres séparément sur
   Cybrancy avant d'y redémarrer l'application. Les secrets de la preview Replit
   ne configurent pas Cybrancy.
4. Si elles ne sont pas déjà appliquées à la base MySQL utilisée, exécuter
   `migrations/mysql/008_notification_outbox.sql`,
   `migrations/mysql/009_password_reset.sql` et
   `migrations/mysql/010_signup_email_verification.sql` dans cet ordre.

La configuration incomplète fait échouer le démarrage. En l'absence complète
de configuration Mailtrap, les dépôts restent utilisables, mais l'inscription
et la récupération du mot de passe nécessitant l'envoi d'e-mails restent
indisponibles.

## File et confidentialité

Les destinataires proviennent du compte utilisateur en base, jamais du
corps de la requête publique. Le contenu et les liens sont chiffrés dans la
file MySQL avant tout envoi. La clé de chiffrement est dérivée du jeton
Mailtrap : **vider la file des messages en attente avant de faire tourner le
jeton**, sinon les anciens messages deviendront indéchiffrables. Une
révocation urgente du jeton est possible, mais les demandes concernées
devront être renouvelées.

Le worker envoie les messages après validation de la transaction métier,
réessaie les échecs réseau, les 408/429 et les 5xx avec délai croissant
(8 tentatives maximum), et efface les messages définitivement refusés.
Une réponse 200 avec `success: true` et un seul `message_id` est considérée
comme acceptée par Mailtrap, pas comme preuve de réception dans la boîte.
Mailtrap ne documente pas de clé d'idempotence pour ce point d'accès :
une panne de la base après acceptation peut entraîner un second e-mail lors
de la reprise. Les messages rejetés ne repartent pas automatiquement après
une correction de configuration ; il faut demander un nouveau code.

Les OTP sont à usage unique, expirent après 10 minutes, permettent 5 essais
et respectent un délai d'une minute et une limite de 5 codes par heure et
par compte. Un compte non vérifié ne peut pas se connecter.

## Vérifications

```sql
SELECT status, COUNT(*) AS total FROM notification_outbox GROUP BY status;
SELECT attempts, last_http_status, created_at, finished_at
FROM notification_outbox WHERE status='failed' ORDER BY created_at DESC LIMIT 50;
```

Ne jamais afficher les codes, destinataires, corps des e-mails, liens ou
jetons dans les journaux. Les tests automatisés utilisent des doubles et
n'envoient pas de véritables e-mails. La preview Replit utilise une base
MariaDB locale isolée ; vérifier l'envoi réel avec un compte de test après
configuration, puis consulter les journaux d'e-mails Mailtrap.