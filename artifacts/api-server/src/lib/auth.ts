import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger";
import crypto from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { getMysqlPool } from "./mysql";

export interface AuthedRequest extends Request {
  userId?: string;
  /** Legacy archive-route compatibility; custom sessions never set this. */
  userToken?: string;
  isAdmin?: boolean;
}

export async function requireUser(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.["bb_session"];
  if (!token) { res.status(401).json({ error: "Authentification requise" }); return; }
  try {
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const [rows] = await getMysqlPool().execute<(RowDataPacket & { user_id: string })[]>(
      "SELECT user_id FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > NOW() LIMIT 1",
      [hash],
    );
    if (!rows[0]?.user_id) { res.status(401).json({ error: "Session invalide" }); return; }
    req.userId = rows[0].user_id;
    next();
  } catch (err) {
    logger.error({ err }, "auth verification failed");
    res.status(500).json({ error: "Auth verification failed" });
    return;
  }
}

export async function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.userId) {
    res.status(401).json({ error: "Authentification requise" });
    return;
  }
  try {
    const [rows] = await getMysqlPool().execute<(RowDataPacket & { role: string })[]>(
      "SELECT role FROM user_roles WHERE user_id = ? AND role = 'admin' LIMIT 1", [req.userId],
    );
    if (!rows[0]) { res.status(403).json({ error: "Accès admin requis" }); return; }
    req.isAdmin = true;
    next();
  } catch (err) {
    logger.error({ err }, "admin role verification failed");
    res.status(500).json({ error: "Role verification failed" });
    return;
  }
}
