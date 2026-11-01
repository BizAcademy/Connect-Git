# Intentions Sabito à configurer — Buzz Booster

Ces configurations sont **proposées, à valider dans le dashboard Sabito**.
Aucune intention ni réponse approuvée n'a été créée depuis ce dépôt.
Slug produit : `buzzbooster`. Supprimer/désactiver l'intention
`account_activation` et ne pas activer `withdrawal_status`.

## Parcours commun obligatoire

1. Réponse générale validée par l'équipe, sans prétendre avoir vérifié des données.
2. Proposer une vérification et attendre oui/non.
3. Si visiteur, demander une connexion ; ne pas déclencher de consultation privée.
4. Collecter les champs exacts ci-dessous, sans demander secret, mot de passe,
   capture contenant des données sensibles, clé crypto ou phrase de récupération.
5. Appeler le `backend_function` identique au nom du handler.
6. Afficher le résultat réel. `error` n'est jamais une confirmation.

## Correspondance exacte

| Déclencheurs et synonymes ciblés | Réponse générale proposée à valider | Confirmation | Champs collectés | `backend_function` | Réponse de résultat proposée |
|---|---|---|---|---|---|
| dépôt non reçu ; recharge non créditée ; paiement crypto non crédité | Le crédit dépend de la confirmation et de son enregistrement sur votre compte. | Voulez-vous vérifier ce dépôt ? | Au moins `deposit_number`, `transaction_id` ou `phone_number` ; pays `country` et méthode `payment_method` si nécessaires | `deposit_status` | État : {statut}. {details_transaction} Référence : {reference}. Montant : {montant} {devise}. Crédit enregistré : {montant_credit_enregistre} {devise_credit_enregistre}. |
| où est ma commande ; statut de mon boost ; abonnés non livrés | Le suivi d'une commande dépend de son état réel et des informations du fournisseur. | Voulez-vous consulter cette commande ? | `order_number` | `order_status` | État : {statut}. {details_transaction} Commande : {reference}. Service : {service}. Quantité : {quantite}. |
| commande annulée mais pas remboursée ; remboursement de commande manquant | Une annulation ne garantit pas que le solde a déjà été recrédité. | Voulez-vous vérifier le remboursement de cette commande ? | `order_number` | `order_refund_status` | État : {statut}. {details_transaction} Montant remboursé : {montant} {devise}. |
| bonus de dépôt manquant ; prime de recharge absente | Le bonus dépend des règles du dépôt et de son attribution effective. | Voulez-vous consulter le bonus de ce dépôt ? | Même collecte que `deposit_status` | `deposit_bonus_status` | État : {statut}. {details_transaction} Montant enregistré : {montant} {devise}. |
| mon code de parrainage ; retrouver mon code affilié | Votre code existant est personnel à votre compte. | Voulez-vous consulter votre code de parrainage ? | Aucun | `referral_code` | Votre code de parrainage : {code}. |
| commission non reçue ; récompense de parrainage manquante | Une commission dépend de son attribution réelle, pas seulement de l'inscription d'un filleul. | Voulez-vous consulter votre commission ? | `referral_number` si plusieurs récompenses correspondent ; référence de la récompense, jamais paiement privé du filleul | `referral_reward_status` | État : {statut}. {details_transaction} Montant : {montant} {devise}. Référence : {reference}. |
| bonus de bienvenue du filleul ; mon bonus reçu comme filleul | Le bonus du filleul doit être enregistré sur son propre compte. | Voulez-vous consulter votre bonus de filleul ? | `referral_number` facultatif | `referee_bonus_status` | État : {statut}. {details_transaction} Montant : {montant} {devise}. |
| mon solde ; solde USD ; solde local | Les portefeuilles local et USD sont distincts. | Voulez-vous consulter vos deux soldes ? | Aucun | `wallet_balance` | État : {statut}. Local : {solde_local} {devise_local}. USD : {solde_usd} {devise_usd}. {details_transaction} |
| pourquoi mon solde a diminué ; vérifier un débit ; identifier un crédit ; ajustement du solde | Un changement de solde doit être expliqué par un mouvement enregistré. | Voulez-vous consulter ce mouvement précis ? | `movement_number` ; `movement_type` pour lever une ambiguïté | `wallet_movement_status` | État : {statut}. {details_transaction} Sens : {sens}. Montant : {montant} {devise}. Référence : {reference}. |
| vérifier un ajustement administrateur ; correction manuelle du solde | Un ajustement doit correspondre à un mouvement déjà enregistré sur votre propre compte. | Voulez-vous consulter cet ajustement précis ? | `movement_number` ; ne pas demander le téléphone ni un identifiant d’administrateur | `admin_adjustment_status` | État : {statut}. {details_transaction} Sens : {sens}. Montant : {montant} {devise}. Date : {date}. Référence : {reference}. |

Les déclencheurs ne doivent pas être réduits à « paiement », « bonus » ou
« problème » seuls : ils confondraient plusieurs opérations.

## Collecte et cas particuliers

- `deposit_number` : identifiant local du dépôt, référence d'ordre, de paiement
  ou du prestataire. `transaction_id` : référence réellement enregistrée.
  Les deux, s'ils sont fournis, doivent désigner le même dépôt.
- `phone_number` : numéro exact enregistré. Plusieurs dépôts correspondants :
  demander `deposit_number` ou `transaction_id` en complément ; ne pas choisir
  le premier ni le plus récent. Ne pas confirmer sur la seule déclaration du membre.
- `country`/`payment_method` : valeurs exactes stockées (pays ISO, méthode
  comme `mobile_money` ou `crypto` selon le dépôt), sans correction arbitraire.
- `order_number` : référence locale de commande recommandée. Une référence
  fournisseur identique chez plusieurs fournisseurs peut être ambiguë :
  demander la référence locale, sans exposer l'identifiant du fournisseur.
- `movement_number` : identifiant du mouvement ou référence de son opération.
  En cas de plusieurs lignes, demander l'identifiant précis ou `movement_type` :
  `deposit`, `order_debit`, `refund`, `deposit_bonus`,
  `referral_referrer_bonus`, `referral_referred_bonus`, `admin_adjustment`.
- `referral_number` : référence de la récompense du membre. Ne pas demander
  le compte ou le paiement d'un filleul pour retrouver sa propre commission.
- `admin_adjustment_status` accepte `movement_number` comme référence exacte du
  mouvement ou de son opération. Il impose `type=admin_adjustment` ; un autre
  `movement_type` est refusé. Il ne crée ni ne modifie aucun ajustement.
- Une valeur `null` signifie indisponible/non enregistrée, pas zéro.
  Ne pas afficher « null » littéralement : adapter le modèle de réponse ou
  garder `{statut}` et `{details_transaction}` quand un champ est absent.
- La quantité restante est facultative (`quantite_restante`) et vient du
  fournisseur. Ne pas la convertir en délai ou pourcentage inventé.

## Erreurs et états non disponibles

`not_found` : aucun élément correspondant accessible à ce membre.
`forbidden` : consultation non autorisée.
`error` avec ambiguïté : collecter la référence supplémentaire demandée,
puis relancer seulement après confirmation du membre.
Autre `error` : consultation impossible, ne pas annoncer un paiement confirmé
ou un remboursement effectué.

Les tickets ne définissent pas séparément « remboursement en cours » et
« refusé » : aucune intention ne doit annoncer ces états sur une simple
fermeture de ticket. Aucun texte interne ni identité du personnel n'est exposé.
