import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { requireUser, type AuthedRequest } from "../lib/auth";
import { logger } from "../lib/logger";
import { exchangeSabitoSession, SabitoSessionError } from "../lib/sabito-session";

export function createSabitoRouter(exchange = exchangeSabitoSession): IRouter {
  const router: IRouter = Router();
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

  router.post("/sabito/session", (_req, res, next) => {
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
    next();
  }, requireUser, (req: AuthedRequest, res, next) => {
    // CSRF protection for the existing HttpOnly, SameSite cookie: only accept
    // a browser POST from this exact origin, never a reflected CORS origin.
    // Use Host, not attacker-controlled X-Forwarded-Host. app.ts configures
    // trusted reverse-proxy networks for req.protocol.
    let expectedOrigin: string;
    try {
      if (!req.get("host")) throw new Error("Missing host");
      expectedOrigin = new URL(`${req.protocol}://${req.get("host")}`).origin;
    } catch {
      res.status(403).json({ error: "Origine non autorisée" });
      return;
    }
    if (req.get("origin") !== expectedOrigin || req.get("sec-fetch-site") === "cross-site") {
      res.status(403).json({ error: "Origine non autorisée" });
      return;
    }
    if (!req.is("application/json")) {
      res.status(415).json({ error: "Format JSON requis" });
      return;
    }
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
