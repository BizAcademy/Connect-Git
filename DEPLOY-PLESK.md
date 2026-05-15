# 🚀 Déploiement BUZZ BOOSTER sur Plesk

Ce projet est **pré-buildé** : les dossiers `dist/` sont compilés dans Replit et committés dans Git.
Sur Plesk, il suffit de :

> **`git pull` → "Deploy Now" → "Restart App"** — pas de build à faire sur le serveur.

---

## 📦 Fichiers pré-buildés committés dans Git

```
artifacts/api-server/dist/
├── index.mjs          ← serveur Node.js complet, tout bundlé (~1.7 Mo)
├── pino-*.mjs         ← workers de logs
└── *.mjs.map          ← source maps

artifacts/bizpanel/dist/public/
├── index.html
└── assets/            ← JS, CSS, images (~2 Mo)
```

> **L'API server est 100% auto-suffisant** : Express, Pino, Supabase, etc. sont embarqués
> dans `index.mjs`. Aucun `npm install` n'est nécessaire pour l'API.

---

## 🔧 Configuration Plesk (à faire UNE SEULE FOIS)

### 1. Git dans Plesk

- **Remote** : `https://github.com/BizAcademy/Connect-Git.git`
- **Branch** : `main`
- **Deploy mode** : Manual

### 2. Node.js — API Server

Dans Plesk → votre domaine → **Node.js** :

| Champ | Valeur |
|---|---|
| **Application root** | racine du repo |
| **Application startup file** | `artifacts/api-server/dist/index.mjs` |
| **Application mode** | `production` |

> ⚠️ Ne pas utiliser "NPM install" — tout est déjà bundlé.

### 3. Frontend statique

Servir `artifacts/bizpanel/dist/public/` depuis la racine du domaine.

Règle de réécriture Apache (`.htaccess` à placer dans le document root) :
```apache
RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-f
RewriteRule ^ /index.html [L]
```

Les requêtes `/api/*` doivent être proxifiées vers le serveur Node.js.

### 4. Variables d'environnement (déjà configurées)

```
PORT=<port assigné par Plesk>
NODE_ENV=production
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
AFRIBAPAY_API_USER=pk_live_...
AFRIBAPAY_API_KEY=sk_live_...
AFRIBAPAY_MERCHANT_KEY=mk_live_...
SESSION_SECRET=...
```

---

## 🔄 Workflow de mise à jour (usage courant)

### Dans Replit (Shell) — après chaque modification de code

```bash
# 1. Rebuilder les fichiers dist/ (obligatoire)
bash build-for-plesk.sh

# 2. Pousser vers GitHub (dist/ inclus)
bash push-to-github.sh "description des changements"
```

### Dans Plesk — mettre en ligne

1. **Git** → **"Deploy Now"** (= `git pull` depuis GitHub)
2. **Node.js** → **"Restart App"**
3. ✅ C'est tout !

---

## 📝 Migrations SQL

Les migrations SQL sont dans `migrations/` — à exécuter **manuellement** dans l'éditeur SQL Supabase (par ordre numérique).

La migration `009_orders_rls.sql` est **recommandée** si `SUPABASE_SERVICE_ROLE_KEY` n'est pas disponible — elle permet aux utilisateurs de lire leurs propres commandes et paiements via RLS.
