// ============================================================
// Pré-rendu SEO — BUZZ BOOSTER
// ------------------------------------------------------------
// Le site est une SPA React : le HTML livré ne contient que
// <div id="root"></div>, et tout le contenu est généré par JS.
// Les robots (Google, Bing, réseaux sociaux) reçoivent donc une
// page vide, ce qui nuit gravement au référencement.
//
// Ce script, exécuté APRÈS `vite build`, ouvre la page d'accueil
// dans un navigateur headless, attend son rendu complet, puis
// réécrit dist/public/index.html avec le HTML rendu (contenu
// visible inclus). Le JavaScript reste présent : côté client,
// React reprend la main normalement.
//
// Sortie 100 % statique -> aucun changement côté hébergement Plesk.
// Étape volontairement NON bloquante : en cas d'échec, le build
// continue avec l'index.html standard.
// ============================================================

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "dist/public");
const indexPath = path.join(publicDir, "index.html");

// Routes publiques à pré-rendre. La page d'accueil "/" est la
// seule servie via index.html en production (fallback SPA), donc
// c'est celle qui compte le plus pour le référencement.
const ROUTES = ["/"];

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".xml": "application/xml",
};

if (!fs.existsSync(indexPath)) {
  console.error(`[prerender] introuvable : ${indexPath} — as-tu lancé le build d'abord ?`);
  process.exit(1);
}

// Serveur statique minimal + fallback SPA vers index.html
const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch {
    urlPath = "/"; // URL malformée -> fallback SPA
  }
  const filePath = path.join(publicDir, urlPath);
  if (
    filePath.startsWith(publicDir) &&
    fs.existsSync(filePath) &&
    fs.statSync(filePath).isFile()
  ) {
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": "text/html" });
    fs.createReadStream(indexPath).pipe(res);
  }
});

// Localise un Chromium système (fourni par Nix sur Replit). Il embarque
// ses bibliothèques, contrairement au Chromium téléchargé par puppeteer
// qui échoue souvent (libglib-2.0.so.0 manquant).
function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  for (const bin of ["chromium", "chromium-browser", "google-chrome-stable"]) {
    try {
      const p = execSync(`which ${bin}`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      if (p) return p;
    } catch {
      /* pas trouvé, on continue */
    }
  }
  return undefined; // puppeteer utilisera son Chromium intégré
}

async function main() {
  const { default: puppeteer } = await import("puppeteer");

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  const executablePath = resolveChromePath();
  if (executablePath) console.log(`[prerender] Chromium : ${executablePath}`);

  const browser = await puppeteer.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    for (const route of ROUTES) {
      const page = await browser.newPage();
      await page.goto(`${base}${route}`, {
        waitUntil: "networkidle2",
        timeout: 45000,
      });
      // Attendre le contenu principal (le <h1> du hero)
      await page.waitForSelector("#root h1", { timeout: 20000 }).catch(() => {
        console.warn(`[prerender] <h1> non détecté sur ${route} — capture quand même`);
      });
      // Laisser les animations (framer-motion) se stabiliser
      await new Promise((r) => setTimeout(r, 1200));

      const html = await page.content();

      const outPath =
        route === "/"
          ? indexPath
          : path.join(publicDir, route.replace(/^\//, ""), "index.html");
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, html, "utf8");

      const textLen = (
        html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      ).length;
      console.log(
        `[prerender] ${route} -> ${path.relative(publicDir, outPath)} (${html.length} octets HTML, ~${textLen} caractères de texte)`,
      );

      // Garde-fou : la sortie doit contenir le script React (pour que le
      // client reprenne la main) ET un contenu texte non trivial.
      const hasModule = /<script[^>]+type="module"/.test(html);
      if (!hasModule || textLen < 200) {
        console.warn(
          `[prerender] ⚠️  Sortie suspecte pour ${route} (script module: ${hasModule}, texte: ${textLen} car.) — vérifie le rendu.`,
        );
      }
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  server.close();
  console.error("[prerender] échec :", err && err.message ? err.message : err);
  process.exit(1);
});
