import express, { type Express, type Request } from "express";
import cors from "cors";
import compression from "compression";
import pinoHttp from "pino-http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

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

app.use("/api", router);

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
  const candidates = [
    process.env["FRONTEND_DIST"],
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
