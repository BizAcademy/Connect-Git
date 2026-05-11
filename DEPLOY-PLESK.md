# 🚀 Déploiement BUZZ BOOSTER sur Plesk (Cybrancy)

Ce projet est **pré-buildé** : tout est compilé dans `dist-deploy/` et committé dans Git.
Sur Plesk, il suffit de :

> **`git pull` → "Deploy Now" → "Restart App"** — pas de build à faire.

---

## 📦 Ce que contient `dist-deploy/`

```
dist-deploy/
├── frontend/              ← site statique (HTML/CSS/JS)
│   ├── index.html
│   ├── assets/
│   ├── favicon.svg, opengraph.jpg
│   ├── robots.txt, sitemap.xml
├── api-server/            ← serveur Node.js bundlé
│   ├── index.mjs          ← point d'entrée (tout bundlé)
│   ├── pino-*.mjs         ← workers de logs
│   ├── package.json       ← minimal, AUCUNE dépendance à installer
│   └── start.sh
├── nginx.example.conf
├── ecosystem.config.cjs
└── .env.example
```

> **Important** : `api-server/index.mjs` contient Express, Pino, CORS, Drizzle, etc.
> **Jamais besoin de faire `npm install` sur le serveur Plesk.**

---

## 🔧 Configuration initiale Plesk (à faire UNE SEULE FOIS)

### 1. Créer le dépôt Git dans Plesk

Dans Plesk → votre domaine → **Git** :
- **Remote Git** : `https://github.com/BizAcademy/Connect-Git.git`
- **Branch** : `main`
- **Deploy mode** : **Manual**

### 2. Configurer le frontend (site statique)

Dans Plesk → votre domaine → **Hosting Settings** :
- **Document root** : `.../dist-deploy/frontend`

### 3. Activer Node.js pour l'API

Dans Plesk → votre domaine → **Node.js** :

| Champ | Valeur |
|---|---|
| **Application root** | `.../dist-deploy/api-server` |
| **Application startup file** | `index.mjs` |
| **Application mode** | `production` |

> ⚠️ **NE CLIQUEZ PAS sur "NPM install"** — tout est déjà bundlé.

### 4. Variables d'environnement

Copier `.env.example` → `.env` dans `dist-deploy/api-server/` et remplir :

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
AFRIBAPAY_API_USER=...
AFRIBAPAY_API_KEY=...
AFRIBAPAY_MERCHANT_KEY=...
```

---

## 🔄 Workflow de mise à jour (usage courant)

### Sur Replit (développement)

1. Faire les modifications dans le code
2. **Quand prêt à déployer** — lancer le build :
   ```bash
   pnpm --filter @workspace/bizpanel run build
   pnpm --filter @workspace/api-server run build
   ```
3. Copier les builds dans `dist-deploy/` :
   ```bash
   bash scripts/prepare-deploy.sh
   ```
4. Push vers GitHub :
   ```bash
   bash push-to-github.sh "feat: description des changements"
   ```

### Sur Plesk (mise en ligne)

1. Dans Plesk → **Git** → **"Deploy Now"** (= `git pull`)
2. Dans Plesk → **Node.js** → **"Restart App"**
3. ✅ C'est tout !

---

## 📝 Migrations SQL

Chaque fois qu'une migration SQL est nécessaire, elle sera donnée dans la conversation.
Les fichiers SQL sont dans `migrations/` — à exécuter manuellement dans l'éditeur SQL Supabase.
