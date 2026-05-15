import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { requireUser, type AuthedRequest } from "../lib/auth";
import crypto from "node:crypto";
import { COUNTRY_CURRENCY } from "../lib/currency";

const router: IRouter = Router();

const SUPABASE_URL = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const BUCKET = "avatars";
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED = new Set(["jpg", "jpeg", "png", "webp"]);

function serviceHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY!}`,
  };
}

function hasStorage(): boolean {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

// POST /api/profile/avatar — upload a new avatar (base64 data URL)
router.post("/profile/avatar", requireUser, async (req: AuthedRequest, res) => {
  if (!hasStorage()) {
    return res.status(503).json({ error: "Stockage non configuré" });
  }

  const dataUrl: string | undefined = req.body?.image;
  if (!dataUrl) return res.status(400).json({ error: "Image manquante" });

  const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i.exec(dataUrl);
  if (!m) return res.status(400).json({ error: "Format d'image invalide" });

  let ext = m[1]!.toLowerCase();
  if (ext === "jpeg") ext = "jpg";
  if (!ALLOWED.has(ext)) return res.status(400).json({ error: "Type non supporté" });

  const buf = Buffer.from(m[2]!, "base64");
  if (buf.byteLength > MAX_BYTES) {
    return res.status(413).json({ error: "Image trop volumineuse (max 2 MB)" });
  }

  const contentType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  const userId = req.userId!;
  const safe = userId.replace(/[^a-zA-Z0-9]/g, "");
  const filename = `${safe}-${crypto.randomBytes(6).toString("hex")}.${ext}`;

  try {
    // Supprimer l'ancien avatar si présent
    const oldRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${userId}&select=avatar_url`,
      { headers: { ...serviceHeaders(), Accept: "application/json" } },
    );
    if (oldRes.ok) {
      const rows = await oldRes.json().catch(() => []);
      const oldUrl: string | null = Array.isArray(rows) && rows[0]?.avatar_url ? rows[0].avatar_url : null;
      if (oldUrl) {
        const oldName = oldUrl.split(`/${BUCKET}/`)[1];
        if (oldName) {
          await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(oldName)}`, {
            method: "DELETE",
            headers: serviceHeaders(),
          }).catch(() => {});
        }
      }
    }

    // Upload nouveau fichier
    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(filename)}`,
      {
        method: "POST",
        headers: { ...serviceHeaders(), "Content-Type": contentType, "x-upsert": "false" },
        body: new Uint8Array(buf),
      },
    );
    if (!uploadRes.ok) {
      const detail = await uploadRes.text().catch(() => "");
      logger.error({ status: uploadRes.status, detail }, "avatar upload failed");
      return res.status(502).json({ error: "Échec de l'upload" });
    }

    // URL publique
    const avatarUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(filename)}`;

    // Mettre à jour profiles.avatar_url
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${userId}`,
      {
        method: "PATCH",
        headers: { ...serviceHeaders(), "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ avatar_url: avatarUrl }),
      },
    );
    if (!patchRes.ok) {
      logger.error({ status: patchRes.status }, "avatar profile patch failed");
      return res.status(502).json({ error: "Impossible de mettre à jour le profil" });
    }

    res.json({ avatar_url: avatarUrl });
  } catch (err) {
    logger.error({ err }, "avatar upload error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/profile/avatar — supprimer la photo de profil
router.delete("/profile/avatar", requireUser, async (req: AuthedRequest, res) => {
  if (!hasStorage()) return res.status(503).json({ error: "Stockage non configuré" });

  const userId = req.userId!;
  try {
    const oldRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${userId}&select=avatar_url`,
      { headers: { ...serviceHeaders(), Accept: "application/json" } },
    );
    if (oldRes.ok) {
      const rows = await oldRes.json().catch(() => []);
      const oldUrl: string | null = Array.isArray(rows) && rows[0]?.avatar_url ? rows[0].avatar_url : null;
      if (oldUrl) {
        const oldName = oldUrl.split(`/${BUCKET}/`)[1];
        if (oldName) {
          await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(oldName)}`, {
            method: "DELETE",
            headers: serviceHeaders(),
          }).catch(() => {});
        }
      }
    }

    await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${userId}`,
      {
        method: "PATCH",
        headers: { ...serviceHeaders(), "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ avatar_url: null }),
      },
    );

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "avatar delete error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/profile/country — set or update the user's country
router.post("/profile/country", requireUser, async (req: AuthedRequest, res) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Service non configuré" });
  }

  const country = String(req.body?.country || "").toUpperCase().trim();
  if (!country || !/^[A-Z]{2}$/.test(country)) {
    return res.status(400).json({ error: "Code pays invalide (ISO2 attendu)" });
  }

  const info = COUNTRY_CURRENCY[country];
  if (!info) {
    return res.status(400).json({ error: "Pays non supporté" });
  }

  const userId = req.userId!;
  try {
    // Use return=representation so we can detect 0-row updates (race condition:
    // profile row may not exist yet when called immediately after signUp).
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${userId}`,
      {
        method: "PATCH",
        headers: {
          ...serviceHeaders(),
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({ country, currency: info.currency }),
      },
    );
    if (!patchRes.ok) {
      const detail = await patchRes.text().catch(() => "");
      logger.error({ status: patchRes.status, detail }, "country update PATCH failed");
      return res.status(502).json({ error: "Impossible de mettre à jour le pays" });
    }
    const rows = (await patchRes.json().catch(() => [])) as unknown[];
    if (rows.length > 0) {
      // Row existed and was updated
      return res.json({ ok: true, country, currency: info.currency });
    }

    // 0 rows updated → profile row not yet created (signup trigger lag).
    // Retry up to 3× with backoff before giving up.
    logger.warn({ userId }, "country PATCH updated 0 rows — profile not yet created, retrying");
    let upserted = false;
    for (let attempt = 0; attempt < 3 && !upserted; attempt++) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      const retryRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${userId}`,
        {
          method: "PATCH",
          headers: {
            ...serviceHeaders(),
            "Content-Type": "application/json",
            Prefer: "return=representation",
          },
          body: JSON.stringify({ country, currency: info.currency }),
        },
      );
      if (!retryRes.ok) continue;
      const retryRows = (await retryRes.json().catch(() => [])) as unknown[];
      if (retryRows.length > 0) { upserted = true; }
    }
    if (!upserted) {
      logger.error({ userId }, "country: profile row never appeared after 3 retries");
      return res.status(503).json({ error: "Profil non encore disponible, réessayez dans quelques secondes" });
    }
    res.json({ ok: true, country, currency: info.currency });
  } catch (err) {
    logger.error({ err }, "country update error");
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
