import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger";

const SUPABASE_URL = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
const SUPABASE_ANON_KEY = process.env["SUPABASE_ANON_KEY"] || process.env["VITE_SUPABASE_ANON_KEY"];

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Missing required environment variables: SUPABASE_URL and SUPABASE_ANON_KEY must be set");
}

export interface AuthedRequest extends Request {
  userId?: string;
  userToken?: string;
  isAdmin?: boolean;
}

export async function requireUser(req: AuthedRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Authentification requise" });
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return res.status(401).json({ error: "Session invalide" });
    const data = (await r.json()) as { id?: string };
    if (!data?.id) return res.status(401).json({ error: "Utilisateur introuvable" });
    req.userId = data.id;
    req.userToken = token;
    next();
  } catch (err) {
    logger.error({ err }, "auth verification failed");
    res.status(500).json({ error: "Auth verification failed" });
  }
}

export async function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.userId || !req.userToken) {
    return res.status(401).json({ error: "Authentification requise" });
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/has_role`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${req.userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ _user_id: req.userId, _role: "admin" }),
    });
    if (!r.ok) return res.status(403).json({ error: "Accès refusé" });
    const isAdmin = await r.json();
    if (isAdmin !== true) return res.status(403).json({ error: "Accès admin requis" });
    req.isAdmin = true;
    next();
  } catch (err) {
    logger.error({ err }, "admin role verification failed");
    res.status(500).json({ error: "Role verification failed" });
  }
}
