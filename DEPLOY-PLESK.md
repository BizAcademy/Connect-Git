# 🚀 Déploiement BUZZ BOOSTER sur Plesk

Ce projet est **pré-buildé** : tout est déjà compilé dans le dossier
`dist-deploy/` et committé dans Git. Sur Plesk, il suffit donc de :

> **`git pull` → "Deploy Now" → "Restart App"** — pas de build à faire.

---

## 📦 Ce que contient `dist-deploy/`

```
dist-deploy/
├── frontend/              ← site statique (HTML/CSS/JS) — ~1.6 MB
│   ├── index.html
│   ├── assets/
│   ├── favicon.svg, opengraph.jpg
│   ├── robots.txt, sitemap.xml
├── api-server/            ← serveur Node.js bundlé — ~5.3 MB
│   ├── index.mjs          ← point d'entrée (tout est bundlé dedans)
│   ├── pino-*.mjs         ← workers de logs
│   ├── package.json       ← minimal, AUCUNE dépendance à installer
│   └── start.sh
├── nginx.example.conf
├── ecosystem.config.cjs
└── .env.example
```

**Important** : `api-server/index.mjs` contient déjà Express, Pino, CORS,
Drizzle, etc. (bundlés par esbuild). **Il n'y a JAMAIS besoin de faire
`npm install` sur le serveur Plesk.**

---

## 🔧 Configuration initiale Plesk (à faire UNE SEULE FOIS)

### 1. Créer le dépôt Git dans Plesk

Dans Plesk → votre domaine → **Git** :

- **Repository name** : `buzzbooster`
- **Remote Git** : URL de votre dépôt GitHub
- **Server path** : `/httpdocs/buzzbooster` (ou un chemin de votre choix)
- **Deploy mode** : **Manual** (vous cliquez "Deploy Now")
- **Branch** : `main`

> Après la création, Plesk fait un premier `git clone`.

### 2. Configurer le frontend (site statique)

Dans Plesk → votre domaine → **Hosting & DNS → Hosting Settings** :

- **Document root** : `/httpdocs/buzzbooster/dist-deploy/frontend`

> C'est tout. Plesk/nginx servira automatiquement les fichiers statiques.

### 3. Activer Node.js pour l'API

Dans Plesk → votre domaine → **Node.js** :

| Champ | Valeur |
|---|---|
| **Node.js version** | 20.x ou supérieur |
| **Document root** | `/httpdocs/buzzbooster/dist-deploy/frontend` |
| **Application mode** | `production` |
| **Application root** | `/httpdocs/buzzbooster/dist-deploy/api-server` |
| **Application URL** | `https://votre-domaine.com/api` |
| **Application startup file** | `index.mjs` |

Cliquez ensuite sur **"Enable Node.js"**.

> ⚠️ **NE CLIQUEZ PAS sur "NPM install"** — pas nécessaire, tout est bundlé.

### 4. Renseigner les variables d'environnement (.env)

Dans Plesk → Node.js → **Custom environment variables** (ou créer un fichier
`.env` dans `dist-deploy/api-server/`), copier le contenu de
`dist-deploy/.env.example` et remplir avec vos vraies valeurs :

```
NODE_ENV=production
PORT=8080
PUBLIC_API_URL=https://votre-domaine.com
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
AFRIBAPAY_API_USER=...
AFRIBAPAY_API_KEY=...
AFRIBAPAY_MERCHANT_KEY=...
SMM_PANEL_API_URL=...
SMM_PANEL_API_KEY=...
... (jusqu'à SMM_PANEL_5_*)
```

### 5. Configurer le proxy nginx pour `/api`

Dans Plesk → votre domaine → **Apache & nginx Settings** →
**Additional nginx directives** :

```nginx
location /api/ {
    proxy_pass         http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
}

# SPA fallback : toutes les routes non-fichier renvoient index.html
location / {
    try_files $uri $uri/ /index.html;
}

# Cache long pour les assets fingerprintés
location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

> Adaptez le port `8080` si Plesk en attribue un autre à votre app Node.

### 6. Mettre à jour les URL dans le SEO

Avant le **premier** push, remplacer `votre-domaine.com` par votre vrai
domaine dans :

- `artifacts/bizpanel/index.html` (balises `<meta>` et Open Graph)
- `artifacts/bizpanel/public/robots.txt`
- `artifacts/bizpanel/public/sitemap.xml`

Puis relancer un build : `bash deploy.sh` et committer.

---

## 🔄 Cycle de mise à jour (à chaque modification)

### Côté Replit (développement)

```bash
# 1. Faire vos modifs dans le code
# 2. Relancer le build de production
bash deploy.sh

# 3. Committer ET pousser le dist-deploy/ régénéré
git add -A
git commit -m "Mise à jour : <description>"
git push origin main
```

### Côté Plesk (production)

1. Plesk → votre domaine → **Git** → **"Deploy Now"**
   → Plesk fait un `git pull` (récupère le nouveau `dist-deploy/`)
2. Plesk → **Node.js** → **"Restart App"**
   → Le serveur API redémarre avec le nouveau bundle

**C'est tout !** Aucun build, aucun `npm install`, aucune compilation
sur le serveur Plesk.

---

## 🧪 Vérifier que ça fonctionne

Après le redémarrage :

```bash
# Page d'accueil (site statique)
curl -I https://votre-domaine.com/

# API (santé du serveur Node)
curl https://votre-domaine.com/api/healthz

# Sitemap pour Google
curl https://votre-domaine.com/sitemap.xml
```

Puis soumettez `https://votre-domaine.com/sitemap.xml` à
**[Google Search Console](https://search.google.com/search-console)**.

---

## ❓ FAQ

### Pourquoi `dist-deploy/` est-il committé dans Git ?

Pour que Plesk n'ait **rien à compiler**. Le serveur Plesk fait juste :
`git pull` → relit les fichiers déjà compilés → redémarre. Cela évite :
- d'installer pnpm/Node sur Plesk
- d'attendre 2-5 min de build à chaque déploiement
- les erreurs de mémoire pendant le build sur petits VPS

### Faut-il vraiment ne PAS faire `npm install` sur Plesk ?

Non. Le fichier `dist-deploy/api-server/index.mjs` est un bundle complet
généré par esbuild qui contient tout le code d'Express, Pino, etc.
Le `package.json` du dossier ne déclare aucune dépendance.

### Combien pèse le dépôt Git avec `dist-deploy/` ?

~7 MB par version. Acceptable pour un dépôt GitHub privé.

### Comment changer le port d'écoute de l'API ?

Dans le `.env` côté Plesk : `PORT=8080` (ou autre). Pensez à mettre à jour
le `proxy_pass` nginx en conséquence.
