# Guide de déploiement BUZZ BOOSTER sur Plesk

## Workflow complet (Replit → GitHub → Plesk)

### 1. Après chaque modification du code sur Replit

```bash
# Étape 1 : Build de production (frontend + API)
bash build-for-plesk.sh

# Étape 2 : Push vers GitHub
bash push-to-github.sh "description de vos changements"
```

Avant l'envoi, vérifier les fichiers supprimés avec `git diff --name-status origin/main..HEAD`. Le script n'écrase plus la branche distante : si GitHub a reçu d'autres modifications, il s'arrête au lieu de forcer le push.

### 2. Dans Plesk — Déployer la nouvelle version

1. Aller dans **Git** → cliquer **Pull** (pour récupérer les nouveaux fichiers depuis GitHub)
2. Cliquer **Deploy Now**
3. Après sauvegarde de la base, pour la mise à jour de la vérification par e-mail : dans l'application Node.js dont l'Application Root est `dist-deploy/api-server`, lancer une fois le script npm **`migrate:account-emails`**. Il applique uniquement les migrations 008 à 012 et ignore celles déjà enregistrées ; ne pas relancer toute la série d'anciennes migrations à la place.
4. Cliquer **Restart** (ou redémarrer l'app Node.js)

**Aucun build n'est nécessaire dans Plesk.** Les migrations ajoutent les tables d'e-mails et de vérification. La migration 012 retire le statut « e-mail vérifié » des anciens comptes sans historique OTP, y compris les administrateurs. Les sessions des non-administrateurs concernés ne donnent alors plus accès au tableau de bord et ils doivent confirmer leur adresse à leur prochaine connexion. Les administrateurs restent exemptés tant qu'ils conservent ce rôle ; les comptes déjà confirmés par OTP conservent leur statut. Les nouveaux comptes doivent saisir le code reçu.

---

## Configuration Plesk requise (une seule fois)

### Application Node.js

| Paramètre | Valeur |
|-----------|--------|
| Document Root | `dist-deploy/api-server/public` |
| Application Root | `dist-deploy/api-server` |
| Startup file | `index.mjs` |
| Node.js version | 20+ |

### Variables d'environnement (Plesk → Node.js → Environment Variables)

```
NODE_ENV=production
PORT=<port assigné par Plesk>
MYSQL_HOST=<hôte MySQL>
MYSQL_PORT=3306
MYSQL_DATABASE=<base MySQL>
MYSQL_USER=<utilisateur MySQL>
MYSQL_PASSWORD=<mot de passe MySQL>
MAILTRAP_API_TOKEN=<jeton Mailtrap>
MAILTRAP_FROM_EMAIL=<adresse d'envoi validée>
NOTIFICATION_APP_URL=https://buzzbooster.site
SUPABASE_SERVICE_ROLE_KEY=<votre clé>
AFRIBAPAY_API_USER=<votre clé>
AFRIBAPAY_API_KEY=<votre clé>
AFRIBAPAY_MERCHANT_KEY=<votre clé>
AFRIBAPAY_API_BASE=https://api.afribapay.com
PUBLIC_API_URL=https://votre-domaine.com
SMM_PANEL_4_API_URL=<url>
SMM_PANEL_4_API_KEY=<clé>
SMM_PANEL_5_API_URL=<url>
SMM_PANEL_5_API_KEY=<clé>
SESSION_SECRET=<secret aléatoire long>
```

Pour l'inscription avec code, l'application Node.js vérifie précisément `MAILTRAP_API_TOKEN` et `MAILTRAP_FROM_EMAIL`. Les variables `BCA_NOTIFICATION_*` ne les remplacent pas. `BCA_NOTIFICATION_APP_URL` peut remplacer `NOTIFICATION_APP_URL` pour les liens des e-mails de compte.

> **Note** : Les variables `VITE_SUPABASE_URL` et `VITE_SUPABASE_ANON_KEY` sont intégrées
> dans le build frontend (statique) — elles n'ont PAS besoin d'être dans Plesk.

---

## Structure des fichiers déployés

```
dist-deploy/
└── api-server/
    ├── index.mjs          ← Point d'entrée du serveur Node.js
    ├── package.json       ← "start": "node --enable-source-maps index.mjs"
    ├── pino-*.mjs         ← Workers du logger (requis au runtime)
    └── public/            ← Frontend React buildé (servi en statique)
        ├── index.html
        └── assets/
```

---

## Résolution de problèmes

### L'app ne démarre pas
- Vérifier que le **Startup file** est bien `index.mjs` (pas `index.js`)
- Vérifier que Node.js ≥ 20 est sélectionné dans Plesk
- Vérifier les variables d'environnement manquantes dans les logs Plesk

### Page blanche après déploiement
- Vérifier que le **Document Root** pointe vers `dist-deploy/api-server/public`
- Vérifier que `public/index.html` existe dans le repo GitHub

### Erreur 502 / Cannot connect
- Vérifier que `PORT` est bien défini (Plesk l'assigne automatiquement si laissé vide)
- Cliquer **Restart** dans Plesk après chaque modification des variables d'env
