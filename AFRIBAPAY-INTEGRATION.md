# Dépôts AfribaPAY — règles d’intégration

Source : https://docs.afribapay.com/, collection officielle Postman publiée
sur ce domaine, consultée le 1er novembre 2026.

## Références et consultations

- `order_id` est créé par Buzz Booster : une référence `BUZZ_…` ou `BB-…`
  n’est pas un identifiant de transaction AfribaPAY.
- `transaction_id` est créé par AfribaPAY ; ses préfixes sont `PIM` / `POM`.
- La documentation autorise **soit** `GET /v1/status?transaction_id=…`,
  **soit** `GET /v1/status?order_id=…`, jamais les deux dans la même requête.
- Le serveur privilégie la transaction AfribaPAY enregistrée. Les anciens
  paiements sans identifiant valide restent consultables avec leur `order_id`.
  Aucun changement SQL ni renommage des références historiques n’est nécessaire.
- Les réponses incohérentes avec les références du dépôt sont rejetées avant
  tout crédit. Les routes membre continuent de vérifier le propriétaire.
- Seul `SUCCESS` confirme un paiement et seul `FAILED` confirme son échec.
  `PENDING`, un dépassement de délai ou une erreur réseau ne valent pas échec.
  Le scanner conserve les paiements en attente et parcourt ses lots pour ne
  pas laisser d’anciens dépôts bloquer les plus récents. Le crédit reste
  transactionnel et idempotent dans le service existant.
- Si l’initiation perd la réponse prestataire ou reçoit une erreur serveur
  ambiguë, la référence marchand est renvoyée au client pour vérifier le même
  dépôt, au lieu de l’encourager à relancer un second paiement.
- Le retour du navigateur n’est jamais une preuve de paiement ; il relance la
  consultation authentifiée. Les notifications signées restent inchangées.

## Wave, Djamo et moyens ajoutés

Le PAYIN Wave et l’exemple Djamo renvoient leur URL dans
`data.provider_link` (la description Djamo mentionne également `payment_link`).
Ces champs sont désormais reconnus avant les anciens alias.

Après création du dépôt :
1. Le frontend conserve temporairement la référence et le contexte du paiement
   dans le `sessionStorage` de ce membre, sans téléphone ni identifiants secrets.
2. Il navigue dans le même onglet vers le lien HTTPS retourné par AfribaPAY ;
   aucune fenêtre asynchrone susceptible d’être bloquée n’est requise.
3. Wave peut ouvrir son application ou sa page de paiement selon l’appareil.
   Djamo affiche sa page/son QR de validation.
4. Le retour ou un rechargement réouvre **le même dépôt**, puis vérifie le
   statut serveur. Aucun deuxième PAYIN n’est créé à ce moment-là.
5. Un bouton permet de rouvrir le lien. Si le navigateur interdit le stockage,
   l’ouverture reste manuelle afin de préserver la page de suivi.

Les paramètres documentés `return_url`, `cancel_url`, `notify_url` et `lang`
sont transmis. Le retour utilise le domaine configuré par `PUBLIC_API_URL`,
sur `/dashboard/deposit?payment=<order_id>`.

Compléments du catalogue :
- Côte d’Ivoire : `djamo`, en plus des opérateurs déjà annoncés par l’API.
- Burkina Faso : `wave` et `wligdicash` (Wallet LigdiCash avec OTP).
- Aucune entrée explicitement désactivée ou réservée aux PAYOUT dans la réponse
  AfribaPAY n’est réactivée par ces compléments ; le coupe-circuit existant
  continue de masquer les opérateurs en panne.

Les codes sont ceux des **requêtes** documentées, et non des libellés
possiblement différents dans les exemples de réponse.
Leur disponibilité effective dépend du compte marchand et d’AfribaPAY.

Le montant est choisi **avant** l’OTP. La demande `/v1/pay/otp` transmet
l’opérateur, le pays, le téléphone, le montant débité avec les frais existants,
la devise déterminée côté serveur et la clé marchand serveur.
Les instructions USSD publiées sont utilisées lorsqu’elles existent ;
LigdiCash utilise la demande OTP et non un code USSD inventé.

## Rafraîchissement visuel

Le tableau de bord, les remboursements, les transactions au retour sur l’onglet
et la liste des pays conservent le contenu existant pendant les rafraîchissements
silencieux. Les appels concurrents sont évités. L’identité membre et les
fonctions de rafraîchissement du profil sont stables afin qu’un solde actualisé
ne redémarre pas les effets des pages.

## Vérification sans argent réel

```bash
node --test artifacts/api-server/tests/afribapay-contract.test.mjs \
  artifacts/api-server/tests/afribapay-fees.test.mjs \
  artifacts/api-server/tests/payment-notification-hooks.test.mjs \
  artifacts/api-server/tests/deposit-invoice.test.mjs
```

Ces tests interceptent les appels prestataire avec des réponses de documentation
et des fixtures locales : ils ne prouvent pas la disponibilité de l’opérateur
sur le compte marchand ni le paiement réel sur un téléphone Wave.
Même le **sandbox AfribaPAY peut utiliser de l’argent réel**, selon sa documentation.
Ne pas lancer de PAYIN réel pour un simple test technique.

L’aperçu Replit utilise l’API distante existante. Les modifications locales du
backend ne deviennent actives qu’après le push manuel puis
**Pull Now → Deploy Now → Restart Now** dans Cybrancy.

Aucune migration SQL n’est requise. Aucun solde ni dépôt historique n’a été
modifié par cette adaptation.
