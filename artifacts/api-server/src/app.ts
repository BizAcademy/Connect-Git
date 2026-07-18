import express, { type Express, type Request } from "express";
import cors from "cors";
import compression from "compression";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Replit (preview/prod) et Plesk/Cybrancy mettent un reverse proxy devant Node.
// Sans `trust proxy`, express-rate-limit identifie tous les clients par l'IP du
// proxy → faux positifs massifs + warning ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
//
// ⚠️ Plesk enchaîne DEUX proxys sur la même machine (nginx → Apache/Passenger).
// Avec `trust proxy = 1`, Express ne remontait qu'un seul saut : tous les
// visiteurs étaient identifiés par l'IP interne du proxy et PARTAGEAIENT le
// même compteur de rate-limit → la liste des utilisateurs du panneau admin
// (et d'autres requêtes) recevait des 429 dès que le site était un peu actif.
// On fait donc confiance à tous les sauts en IP privée/loopback (les proxys
// locaux de Plesk et de Replit), et l'IP client retenue est la première IP
// publique de X-Forwarded-For — non falsifiable, car ajoutée par nginx.
app.set("trust proxy", ["loopback", "linklocal", "uniquelocal"]);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(compression());
app.use(cors());

// Rate limiting — 600 requêtes/minute par IP sur toutes les routes /api.
// 100/min était trop serré : le panneau admin interroge plusieurs endpoints
// en continu (solde total toutes les 15 s, listes, badges…), plusieurs onglets
// ouverts multiplient les appels, et en Afrique francophone beaucoup
// d'utilisateurs partagent la même IP publique (CGNAT des opérateurs mobiles).
// 600/min ≈ 10 req/s par client : indolore pour un humain, bloque toujours
// les inondations de requêtes automatisées.
// Le webhook AfribaPay est exempté pour ne jamais bloquer les paiements entrants.
const apiLimiter = rateLimit({
  windowMs: 60 * 1_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith("/api/payments/webhook"),
  handler: (_req, res) => {
    res.status(429).json({ error: "Trop de requêtes — réessayez dans 1 minute." });
  },
});

// Capture the raw JSON body so webhook handlers (AfribaPay) can verify the
// HMAC-SHA256 signature against the exact bytes received. The verifier writes
// the raw string to `req.rawBody` only for the webhook path to keep memory
// footprint minimal everywhere else.
function captureRawBody(req: Request, _res: unknown, buf: Buffer) {
  if (req.url && req.url.startsWith("/api/payments/webhook")) {
    (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
  }
}

// Allow up to 8 MB JSON payloads to accommodate base64-encoded support images (≤5 MB raw)
app.use(express.json({ limit: "8mb", verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));

app.use("/api", apiLimiter, router);

// ─── Frontend statique (production uniquement) ─────────────────────────────
// En production (déploiement Plesk/Cybrancy), Passenger envoie TOUTES les
// requêtes du domaine au serveur Node.js. On doit donc servir nous-mêmes les
// fichiers statiques du panel React (index.html + assets) et rediriger toutes
// les routes côté client vers index.html (SPA fallback).
//
// En développement (vite dev server), ce bloc est désactivé : vite gère le
// frontend, et le proxy de Replit route /api vers ce serveur séparément.
if (process.env["NODE_ENV"] === "production") {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  // Ordre de recherche du frontend statique :
  //   1) FRONTEND_DIST si défini (override pour cas particuliers)
  //   2) ./public            -> structure standard Plesk Node.js (api-server/public/)
  //   3) ../frontend         -> ancienne structure (frontend en dossier voisin)
  //   4) ../../frontend      -> idem mais une couche plus haut
  const candidates = [
    process.env["FRONTEND_DIST"],
    path.resolve(scriptDir, "./public"),
    path.resolve(scriptDir, "../frontend"),
    path.resolve(scriptDir, "../../frontend"),
  ].filter((p): p is string => Boolean(p));

  const frontendDist = candidates.find((dir) =>
    fs.existsSync(path.join(dir, "index.html")),
  );

  if (frontendDist) {
    logger.info({ frontendDist }, "serving frontend static files");

    app.use(
      express.static(frontendDist, {
        index: false,
        maxAge: "1y",
        setHeaders: (res, filePath) => {
          if (filePath.endsWith("index.html")) {
            res.setHeader("Cache-Control", "no-cache, must-revalidate");
          }
        },
      }),
    );

    // SPA fallback : toute route GET non-/api renvoie index.html
    app.get(/^\/(?!api(\/|$)).*/, (_req, res, next) => {
      const indexFile = path.join(frontendDist, "index.html");
      res.sendFile(indexFile, (err) => {
        if (err) next(err);
      });
    });
  } else {
    logger.warn(
      { tried: candidates },
      "frontend dist directory not found — static files will not be served",
    );
  }
}

export default app;
