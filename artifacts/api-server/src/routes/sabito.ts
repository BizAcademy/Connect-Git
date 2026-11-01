import { Router, type IRouter, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { requireUser, requireAdmin, type AuthedRequest } from "../lib/auth";
import { logger } from "../lib/logger";
import { exchangeSabitoSession, SabitoSessionError } from "../lib/sabito-session";
import { isSabitoEnabled, saveSabitoEnabled } from "../lib/sabito-settings";
import { runSabitoDiagnostics, inspectSabitoEnvironment } from "../lib/sabito-diagnostics";
import { getSabitoConnectorState } from "../lib/sabito-supervisor";

const sameOriginJson: RequestHandler = (req, res, next) => {
  let expected: string;
  try {
    if (!req.get("host")) throw new Error("Missing host");
    expected = new URL(`${req.protocol}://${req.get("host")}`).origin;
  } catch {
    res.status(403).json({ error: "Origine non autorisée" });
    return;
  }
  if (req.get("origin") !== expected || req.get("sec-fetch-site") === "cross-site") {
    res.status(403).json({ error: "Origine non autorisée" });
    return;
  }
  if (!req.is("application/json")) {
    res.status(415).json({ error: "Format JSON requis" });
    return;
  }
  next();
};

export function createSabitoRouter(
  exchange = exchangeSabitoSession,
  settings: { read?: typeof isSabitoEnabled; write?: typeof saveSabitoEnabled } = {},
  diagnostics: {
    run?: typeof runSabitoDiagnostics;
    environment?: typeof inspectSabitoEnvironment;
    connector?: typeof getSabitoConnectorState;
  } = {},
): IRouter {
  const router: IRouter = Router();
  const readEnabled = settings.read ?? isSabitoEnabled;
  const writeEnabled = settings.write ?? saveSabitoEnabled;
  router.use(["/sabito/settings", "/admin/sabito/settings", "/sabito/session", "/admin/sabito/diagnostics"], (_req, res, next) => {
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
    next();
  });
  let diagnosing = false;
  const diagnosticLimiter = rateLimit({
    windowMs: 60_000, limit: 3,
    keyGenerator: (req: AuthedRequest) => `sabito-diagnostic:${req.userId}`,
    standardHeaders: true, legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: "Attends une minute avant de relancer le diagnostic." }),
  });
  router.post("/admin/sabito/diagnostics", requireUser, requireAdmin, sameOriginJson, diagnosticLimiter, async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length) {
      res.status(400).json({ error: "Le diagnostic attend un objet JSON vide." });
      return;
    }
    if (diagnosing) {
      res.status(409).json({ error: "Un diagnostic est déjà en cours." });
      return;
    }
    diagnosing = true;
    try {
      const report = await (diagnostics.run ?? runSabitoDiagnostics)();
      res.json({
        ...report,
        environment: (diagnostics.environment ?? inspectSabitoEnvironment)(),
        connector: (diagnostics.connector ?? getSabitoConnectorState)(),
      });
    } catch {
      res.status(503).json({ error: "Diagnostic serveur indisponible." });
    } finally {
      diagnosing = false;
    }
  });
  router.get("/sabito/settings", async (_req, res) => {
    try {
      res.json({ enabled: await readEnabled() });
    } catch {
      res.status(503).json({ error: "État de Sabito indisponible" });
    }
  });
  router.put("/admin/sabito/settings", requireUser, requireAdmin, sameOriginJson, async (req: AuthedRequest, res) => {
    if (
      !req.body || Array.isArray(req.body) || typeof req.body.enabled !== "boolean" ||
      Object.keys(req.body).length !== 1
    ) {
      res.status(400).json({ error: "Un état Sabito activé ou désactivé est requis." });
      return;
    }
    try {
      await writeEnabled(req.body.enabled, String(req.userId));
      res.json({ enabled: req.body.enabled });
    } catch {
      res.status(503).json({ error: "Impossible d’enregistrer l’état de Sabito." });
    }
  });
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    keyGenerator: (req: AuthedRequest) => `sabito:${req.userId}`,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: "Trop de tentatives Sabito. Réessayez dans une minute." });
    },
  });

  router.post("/sabito/session", requireUser, sameOriginJson, (req: AuthedRequest, res, next) => {
    if (
      !req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
      Object.keys(req.body).length > 0
    ) {
      res.status(400).json({ error: "La requête de session doit contenir uniquement un objet JSON vide." });
      return;
    }
    next();
  }, limiter, async (req: AuthedRequest, res) => {
    if (!req.userId) {
      res.status(401).json({ error: "Authentification requise" });
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    const onClose = () => { if (!res.writableEnded) abort(); };
    res.once("close", onClose);
    try {
      if (!await readEnabled()) {
        res.status(503).json({ error: "Sabito est désactivé." });
        return;
      }
      const session = await exchange(String(req.userId), controller.signal);
      if (!controller.signal.aborted) res.json(session);
    } catch (error) {
      if (controller.signal.aborted) return;
      const known = error instanceof SabitoSessionError;
      logger.warn({ code: known ? error.code : "UNEXPECTED" }, "Sabito session unavailable");
      res.status(known ? error.status : 502).json({
        error: "Sabito est temporairement indisponible. Réessayez plus tard.",
      });
    } finally {
      req.removeListener("aborted", abort);
      res.removeListener("close", onClose);
    }
  });
  return router;
}

export default createSabitoRouter();
