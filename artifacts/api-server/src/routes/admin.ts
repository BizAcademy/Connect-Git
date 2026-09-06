import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { RowDataPacket } from "mysql2/promise";
import { requireUser, requireAdmin, type AuthedRequest } from "../lib/auth";
import { logger } from "../lib/logger";
import { getMysqlPool } from "../lib/mysql";
import { readEarnings, appendEarning, estimateGainFromRevenue } from "../lib/earnings";
import { loadPricing, setEntry, deleteEntry, enrichServices, usdToFcfaRate, getUsdRates, setUsdRatesOverride, clearUsdRatesOverride, USD_TO_LOCAL_RATES } from "../lib/smm-pricing";
import { invalidateServicesCache } from "./smm";
import { callProvider, parseProviderId, getProvider, loadProviderConfig, updateProviderConfig, type ProviderId } from "../lib/smm-providers";
import { NON_CFA_COUNTRIES_INFO, setRateOverrides } from "../lib/currency";
import { BONUS_AMOUNT_FCFA, BONUS_THRESHOLD_FCFA, creditDeposit, markPaymentStatus } from "../lib/deposits";
import { deleteOperatorLogo, fetchOperatorLogos, uploadOperatorLogoFile } from "../lib/operator-logos";
import multer from "multer";

const router: IRouter = Router();
const MAIN_ADMIN_EMAIL = (process.env["MAIN_ADMIN_EMAIL"] || "jude@gmail.com").toLowerCase();
const uploadLogo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

type AdvertisementSegment = { text: string; color: string };
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const IMAGE_RE = /^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=\r\n]+$/i;
const CONTACT_RE = /^(?:https?:\/\/|mailto:|tel:)/i;

function advertisementFromRow(row: RowDataPacket | undefined) {
  if (!row) return { active: false, title: "", segments: [], image: "", contactLabel: "", contactUrl: "", updatedAt: null };
  let segments: AdvertisementSegment[] = [];
  try {
    const raw = typeof row.message_segments === "string" ? JSON.parse(row.message_segments) : row.message_segments;
    if (Array.isArray(raw)) segments = raw;
  } catch {}
  return {
    active: Boolean(row.active),
    title: String(row.title || ""),
    segments,
    image: String(row.image_data || ""),
    contactLabel: String(row.contact_label || ""),
    contactUrl: String(row.contact_url || ""),
    updatedAt: row.updated_at || null,
  };
}

async function readAdvertisement() {
  const [rows] = await getMysqlPool().query<RowDataPacket[]>(
    "SELECT active,title,message_segments,image_data,contact_label,contact_url,updated_at FROM dashboard_advertisement WHERE id=1",
  );
  return advertisementFromRow(rows[0]);
}

router.get("/advertisement", requireUser, async (_req, res) => {
  try {
    const advertisement = await readAdvertisement();
    return res.json({ advertisement: advertisement.active ? advertisement : null });
  } catch (err) {
    logger.error({ err }, "advertisement read");
    return res.status(500).json({ error: "Annonce indisponible" });
  }
});

router.get("/admin/advertisement", requireUser, requireAdmin, async (_req, res) => {
  try { return res.json({ advertisement: await readAdvertisement() }); }
  catch (err) { logger.error({ err }, "admin advertisement read"); return res.status(500).json({ error: "Annonce indisponible" }); }
});

router.put("/admin/advertisement", requireUser, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || "").trim();
  const image = String(b.image || "").trim();
  const contactLabel = String(b.contactLabel || "").trim();
  const contactUrl = String(b.contactUrl || "").trim();
  const segments: AdvertisementSegment[] = Array.isArray(b.segments)
    ? b.segments.map((x: unknown) => {
        const item = x && typeof x === "object" ? x as Record<string, unknown> : {};
        return { text: String(item.text || "").trim(), color: String(item.color || "#374151") };
      }).filter((x: AdvertisementSegment) => x.text)
    : [];
  if (typeof b.active !== "boolean" || title.length > 255 || segments.length > 20 ||
      segments.some(x => x.text.length > 1000 || !COLOR_RE.test(x.color)) ||
      image.length > 6_000_000 || (image && !IMAGE_RE.test(image)) ||
      contactLabel.length > 120 || contactUrl.length > 500 ||
      (contactUrl && !CONTACT_RE.test(contactUrl))) {
    return res.status(400).json({ error: "Contenu de l'annonce invalide" });
  }
  if (b.active && !title && !segments.length && !image && !contactLabel) {
    return res.status(400).json({ error: "Ajoutez au moins un contenu avant d'activer l'annonce" });
  }
  if (contactLabel && !contactUrl) return res.status(400).json({ error: "Ajoutez le lien ou numéro associé au contact" });
  try {
    await getMysqlPool().execute(
      `INSERT INTO dashboard_advertisement
       (id,active,title,message_segments,image_data,contact_label,contact_url,updated_by)
       VALUES (1,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE active=VALUES(active),title=VALUES(title),
       message_segments=VALUES(message_segments),image_data=VALUES(image_data),
       contact_label=VALUES(contact_label),contact_url=VALUES(contact_url),
       updated_by=VALUES(updated_by)`,
      [b.active, title || null, JSON.stringify(segments), image || null, contactLabel || null, contactUrl || null, (req as AuthedRequest).userId],
    );
    return res.json({ ok: true, advertisement: await readAdvertisement() });
  } catch (err) {
    logger.error({ err }, "admin advertisement save");
    return res.status(500).json({ error: "Enregistrement de l'annonce impossible" });
  }
});

function actionCode(req: AuthedRequest, res: import("express").Response, next: import("express").NextFunction) {
  const expected = process.env["ADMIN_ACTION_CODE"];
  if (!expected) return res.status(503).json({ error: "Code de confirmation non configuré côté serveur (secret ADMIN_ACTION_CODE manquant)" });
  const given = String(req.headers["x-admin-action-code"] || "");
  if (!given) return res.status(428).json({ error: "Code de confirmation requis", code_required: true });
  if (given !== expected) return res.status(403).json({ error: "Code de confirmation invalide", code_invalid: true });
  return next();
}
const validDate = (value: unknown) => value && !Number.isNaN(new Date(String(value)).getTime()) ? new Date(String(value)) : null;
async function setting(key: string): Promise<string | null> {
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>("SELECT `value` FROM settings WHERE `key`=?", [key]);
  return rows[0] ? String(rows[0].value) : null;
}
async function putSetting(key: string, value: string, by?: string) {
  await getMysqlPool().execute("INSERT INTO settings (`key`,`value`,updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`),updated_by=VALUES(updated_by)", [key, value, by ?? null]);
}

router.get("/admin/earnings", requireUser, requireAdmin, async (req, res) => {
  try {
    const all = await readEarnings(), now = new Date(), day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const one = 86400000, max = 3650;
    const parseDay = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00.000Z`) : null;
    const to = parseDay(req.query.to) || day;
    let from = parseDay(req.query.from);
    if (!from && (req.query.all === "1" || req.query.all === "true") && all.length) from = new Date(Math.min(...all.map(x => new Date(x.ts).getTime())));
    if (!from) from = new Date(to.getTime() - ((Math.min(Math.max(Number(req.query.days) || 30, 1), max) - 1) * one));
    from = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    if (to.getTime() - from.getTime() > (max - 1) * one) from = new Date(to.getTime() - (max - 1) * one);
    const buckets = new Map<string, { gain: number; revenue: number; count: number }>();
    for (let d = from.getTime(); d <= to.getTime(); d += one) buckets.set(new Date(d).toISOString().slice(0, 10), { gain: 0, revenue: 0, count: 0 });
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), year = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const summary: any = { today: { gain: 0, revenue: 0, orders: 0 }, month: { gain: 0, revenue: 0, orders: 0 }, year: { gain: 0, revenue: 0, orders: 0 }, total: { gain: 0, revenue: 0, orders: 0 } };
    for (const r of all) { const t = new Date(r.ts), add = (x: any) => { x.gain += r.gain_fcfa; x.revenue += r.user_price_fcfa; x.orders++; }; add(summary.total); if (t >= year) add(summary.year); if (t >= month) add(summary.month); if (t >= day) add(summary.today); const b = buckets.get(t.toISOString().slice(0, 10)); if (b) { b.gain += r.gain_fcfa; b.revenue += r.user_price_fcfa; b.count++; } }
    const series = [...buckets].map(([date, x]) => ({ date, ...x })), total = series.reduce((a, x) => ({ gain: a.gain + x.gain, revenue: a.revenue + x.revenue, orders: a.orders + x.count }), { gain: 0, revenue: 0, orders: 0 });
    const avg = all.filter(x => new Date(x.ts) >= new Date(day.getTime() - 29 * one)).reduce((a, x) => a + x.gain_fcfa, 0) / 30;
    res.json({ summary, projections: { daily_avg_30d: Math.round(avg), quarterly: Math.round(avg * 90), semi_annual: Math.round(avg * 182), annual: Math.round(avg * 365), month_run_rate: Math.round(summary.month.gain / now.getUTCDate() * 30), year_run_rate: Math.round(summary.year.gain / (Math.floor((now.getTime() - year.getTime()) / one) + 1) * 365) }, window: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), days: series.length, total }, series });
  } catch (err) { logger.error({ err }, "admin earnings error"); res.status(500).json({ error: "Erreur lecture revenus" }); }
});

router.post("/admin/earnings/backfill", requireUser, requireAdmin, async (_req, res) => {
  try {
    const existing = new Set((await readEarnings()).map(r => `${r.provider ?? 1}:${r.provider_order_id}`));
    const [orders] = await getMysqlPool().query<RowDataPacket[]>("SELECT id,user_id,COALESCE(provider_order_id,external_order_id) external_id,provider,charge_minor,quantity,service_name,created_at FROM orders WHERE status='completed' AND COALESCE(provider_order_id,external_order_id) IS NOT NULL");
    let inserted = 0, skipped = 0;
    for (const o of orders) { const key = `${o.provider}:${o.external_id}`; if (existing.has(key)) { skipped++; continue; } const revenueFcfa = Number(o.charge_minor) / 100; const gain = estimateGainFromRevenue(revenueFcfa); await appendEarning({ ts: new Date(o.created_at).toISOString(), provider_order_id: String(o.external_id), user_id: o.user_id, service: 0, service_name: o.service_name || "", quantity: Number(o.quantity), rate_usd: 0, user_price_fcfa: revenueFcfa, provider_cost_usd: 0, ...gain, provider: Number(o.provider) }); inserted++; }
    res.json({ ok: true, total_orders_scanned: orders.length, inserted, recomputed: 0, skipped_already_present: skipped, skipped_no_external_id: 0 });
  } catch (err) { logger.error({ err }, "earnings backfill error"); res.status(500).json({ error: "Erreur backfill" }); }
});

router.get("/admin/smm-balance", requireUser, requireAdmin, async (req, res) => { try { const provider = parseProviderId(req.query.provider), raw = await callProvider(provider, "balance"), usd = Number(raw?.balance); res.json({ balance_usd: Number.isFinite(usd) ? usd : null, balance_fcfa_equiv: Number.isFinite(usd) ? Math.round(usd * usdToFcfaRate(provider)) : null, currency: raw?.currency || "USD", provider, raw }); } catch (err) { res.status(500).json({ error: (err as Error).message }); } });
router.get("/admin/smm-pricing", requireUser, requireAdmin, async (req, res) => { try { const provider = parseProviderId(req.query.provider); res.json({ services: await enrichServices(await callProvider(provider, "services"), provider), provider }); } catch (err) { res.status(500).json({ error: (err as Error).message }); } });
router.put("/admin/smm-pricing/:serviceId", requireUser, requireAdmin, async (req, res) => { const provider = parseProviderId(req.query.provider), id = String(req.params.serviceId), b = req.body || {}, current = (await loadPricing(provider))[id]; if (!/^\d+$/.test(id)) return res.status(400).json({ error: "service invalide" }); const price = b.price_fcfa === undefined ? current?.price_fcfa : Number(b.price_fcfa); if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: "price_fcfa invalide" }); await setEntry(id, { price_fcfa: Math.round(price), hidden: typeof b.hidden === "boolean" ? b.hidden : current?.hidden, featured: typeof b.featured === "boolean" ? b.featured : current?.featured }, provider); invalidateServicesCache(provider); return res.json({ ok: true, service: Number(id), provider }); });
router.delete("/admin/smm-pricing/:serviceId", requireUser, requireAdmin, async (req, res) => { const provider = parseProviderId(req.query.provider); await deleteEntry(String(req.params.serviceId), provider); invalidateServicesCache(provider); res.json({ ok: true, provider }); });
router.post("/admin/smm-pricing/rescale", requireUser, requireAdmin, async (req, res) => { const p = parseProviderId(req.query.provider), factor = Number(req.body?.factor); if (!Number.isFinite(factor) || factor <= 0 || factor > 100) return res.status(400).json({ error: "factor invalide (attendu : nombre > 0 et ≤ 100)" }); let updated = 0; for (const [id, e] of Object.entries(await loadPricing(p))) { if (e.price_fcfa > 0) { await setEntry(id, { ...e, price_fcfa: Math.round(e.price_fcfa * factor / 10) * 10 }, p); updated++; } } invalidateServicesCache(p); return res.json({ ok: true, provider: p, factor, updated }); });
router.get("/admin/providers", requireUser, requireAdmin, async (_req, res) => { try { res.json({ providers: (await loadProviderConfig()).map(c => ({ ...c, configured: getProvider(c.provider_id)?.configured ?? false })) }); } catch { res.status(500).json({ error: "Lecture fournisseurs impossible" }); } });
router.put("/admin/providers/:id", requireUser, requireAdmin, async (req, res) => { const id = Number(req.params.id) as ProviderId, b = req.body || {}; if (![1, 3, 4, 5].includes(id)) return res.status(400).json({ error: "provider id invalide (1, 3, 4 ou 5)" }); const patch: any = {}; for (const key of ["display_order", "enabled", "header_title", "header_text"]) if (b[key] !== undefined) patch[key] = b[key]; const out = await updateProviderConfig(id, patch); return out.ok ? res.json({ ok: true }) : res.status(500).json({ error: out.error }); });

router.get("/admin/users/total-balance", requireUser, requireAdmin, async (_req, res) => { try { const [r] = await getMysqlPool().query<RowDataPacket[]>("SELECT COALESCE(SUM(balance_minor),0) total_balance,COUNT(*) user_count FROM profiles"); res.json({ total_balance: Number(r[0].total_balance) / 100, user_count: Number(r[0].user_count), currency: "FCFA" }); } catch { res.status(500).json({ error: "Lecture des soldes impossible" }); } });
router.get("/admin/users", requireUser, requireAdmin, async (req, res) => {
  const authReq = req as AuthedRequest;
  const search = String(req.query.search || "").trim(), limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 2000), offset = Math.max(Number(req.query.offset) || 0, 0), term = `%${search}%`;
  try { const [requester] = await getMysqlPool().execute<RowDataPacket[]>("SELECT email FROM users WHERE id=?", [authReq.userId!]); const main = String(requester[0]?.email || "").toLowerCase() === MAIN_ADMIN_EMAIL;
    const where = search ? "WHERE (p.username LIKE ? OR p.email LIKE ? OR u.email LIKE ?)" : ""; const args: any[] = search ? [term, term, term] : [];
    const [rows] = await getMysqlPool().execute<RowDataPacket[]>(`SELECT p.user_id,p.username,COALESCE(p.email,u.email) email,p.country,p.currency,p.balance_minor balance,p.affiliate_earnings_minor affiliate_earnings,IF(u.disabled_at IS NULL,TRUE,FALSE) is_active,u.created_at,IF(ur.user_id IS NULL,'user','admin') role FROM profiles p JOIN users u ON u.id=p.user_id LEFT JOIN user_roles ur ON ur.user_id=p.user_id AND ur.role='admin' ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
    let users = rows.map(r => ({ ...r, balance: Number(r.balance) / 100, affiliate_earnings: Number(r.affiliate_earnings) / 100, is_main_admin: String(r.email).toLowerCase() === MAIN_ADMIN_EMAIL })); if (!main) users = users.filter(x => !x.is_main_admin); res.json({ users, total_count: null, has_more: rows.length === limit, requester_is_main_admin: main });
  } catch (err) { logger.error({ err }, "admin users list"); res.status(500).json({ error: "Lecture des utilisateurs impossible" }); }
});
router.patch("/admin/users/:userId", requireUser, requireAdmin, actionCode, async (req, res) => {
  const authReq = req as AuthedRequest;
  const id = String(req.params.userId), b = req.body || {}; if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: "user_id invalide" }); if (b.balance !== undefined && (!Number.isFinite(Number(b.balance)) || Number(b.balance) < 0)) return res.status(400).json({ error: "Solde invalide" });
  const db = getMysqlPool(), c = await db.getConnection(); try { await c.beginTransaction(); const [profile] = await c.execute<RowDataPacket[]>("SELECT balance_minor FROM profiles WHERE user_id=? FOR UPDATE", [id]); if (!profile[0]) { await c.rollback(); return res.status(404).json({ error: "Utilisateur introuvable" }); } const before = Number(profile[0].balance_minor), after = b.balance === undefined ? before : Math.round(Number(b.balance) * 100);
    const fields: string[] = [], values: any[] = []; for (const [key, col] of [["username", "username"], ["email", "email"], ["country", "country"]] as const) if (typeof b[key] === "string") { fields.push(`${col}=?`); values.push(b[key].trim()); } if (b.balance !== undefined) { fields.push("balance_minor=?"); values.push(after); } if (fields.length) await c.execute(`UPDATE profiles SET ${fields.join(",")} WHERE user_id=?`, [...values, id]); if (typeof b.email === "string" && b.email.trim()) await c.execute("UPDATE users SET email=? WHERE id=?", [b.email.trim().toLowerCase(), id]); if (typeof b.is_active === "boolean") await c.execute(`UPDATE users SET disabled_at=${b.is_active ? "NULL" : "NOW()"} WHERE id=?`, [id]);
    if (after !== before) { const paymentId = randomUUID(); await c.execute("INSERT INTO payments (id,user_id,provider_reference,amount_minor,currency,status,method,credited_at,balance_before_minor,balance_after_minor) VALUES (?,?,?,?,?,'completed','admin_adjustment',NOW(),?,?)", [paymentId, id, `ADJ-${paymentId}`, after - before, "XAF", before, after]); await c.execute("INSERT INTO wallet_transactions (id,user_id,amount_minor,balance_after_minor,currency,type,reference_type,reference_id) VALUES (?,?,?,?,?,'admin_adjustment','payment',?)", [randomUUID(), id, after - before, after, "XAF", paymentId]); await c.execute("INSERT INTO balance_audit_log (user_id,previous_balance_minor,new_balance_minor,reason,actor_user_id) VALUES (?,?,?,?,?)", [id, before, after, "admin_adjustment", authReq.userId!]); }
    await c.commit(); return res.json({ ok: true });
  } catch (err) { await c.rollback(); logger.error({ err }, "admin user update"); return res.status(500).json({ error: "Mise à jour du profil impossible" }); } finally { c.release(); }
});
router.post("/admin/users/:userId/password", requireUser, requireAdmin, actionCode, async (req, res) => { const pass = String(req.body?.password || ""); if (pass.length < 8 || pass.length > 200) return res.status(400).json({ error: "Le mot de passe doit contenir entre 8 et 200 caractères" }); await getMysqlPool().execute("UPDATE users SET password_hash=? WHERE id=?", [await bcrypt.hash(pass, 12), req.params.userId]); return res.json({ ok: true, user_id: req.params.userId }); });

router.get("/admin/deposits", requireUser, requireAdmin, async (req, res) => { try { const q: any = req.query, limit = Math.min(Math.max(Number(q.limit) || 200, 1), 1000), clauses = ["1=1"], args: any[] = []; for (const key of ["status", "bonus_status"]) if (q[key] && q[key] !== "all") { clauses.push(`p.${key}=?`); args.push(q[key]); } if (q.min_amount) { clauses.push("p.amount_minor>=?"); args.push(Math.round(Number(q.min_amount) * 100)); } if (q.max_amount) { clauses.push("p.amount_minor<=?"); args.push(Math.round(Number(q.max_amount) * 100)); } if (q.search) { clauses.push("(p.provider_reference LIKE ? OR p.user_id LIKE ? OR pr.username LIKE ? OR pr.email LIKE ?)"); args.push(...Array(4).fill(`%${q.search}%`)); } const [rows] = await getMysqlPool().execute<RowDataPacket[]>(`SELECT p.id,p.user_id,p.amount_minor amount,p.status,p.method,p.provider_reference reference,p.created_at,p.bonus_amount_minor bonus_amount,p.bonus_status,p.bonus_credited_at,p.credited_at,p.country,p.currency,pr.username user_username,pr.email user_email FROM payments p LEFT JOIN profiles pr ON pr.user_id=p.user_id WHERE ${clauses.join(" AND ")} ORDER BY p.created_at DESC LIMIT ?`, [...args, limit]); const deposits: Array<RowDataPacket & { amount: number; bonus_amount: number; bonus_status: string }> = rows.map(r => ({ ...r, amount: Number(r.amount) / 100, bonus_amount: Number(r.bonus_amount) / 100, bonus_status: String(r.bonus_status) })); res.json({ deposits, counters: { total: deposits.length, total_amount_fcfa: deposits.reduce((a,r) => a+r.amount,0), bonus_pending: deposits.filter(r=>r.bonus_status==="pending").length, bonus_credited: deposits.filter(r=>r.bonus_status==="credited").length, bonus_credited_fcfa: deposits.filter(r=>r.bonus_status==="credited").reduce((a,r)=>a+r.bonus_amount,0), bonus_eligible: deposits.filter(r=>r.amount>=BONUS_THRESHOLD_FCFA).length }, bonus_rule: { threshold_fcfa: BONUS_THRESHOLD_FCFA, bonus_fcfa: BONUS_AMOUNT_FCFA } }); } catch (err) { logger.error({err},"deposits"); res.status(500).json({error:"Erreur interne"}); } });
router.post("/admin/deposits/:id/status", requireUser, requireAdmin, async (req,res) => {
  const status=String(req.body?.status||"");
  if (!["completed","failed","rejected","pending"].includes(status)) return res.status(400).json({error:"statut invalide"});
  if (status !== "completed") {
    const result = await markPaymentStatus(String(req.params.id), status as "failed" | "rejected" | "pending");
    return result.ok ? res.json({ ok: true }) : res.status(result.status ?? 500).json({ error: result.error });
  }
  const result = await creditDeposit(String(req.params.id));
  return result.ok
    ? res.json({ ok:true, already_credited:result.alreadyCredited, amount_credited:result.amountCredited, bonus_credited:result.bonusCredited, new_balance:result.newBalance })
    : res.status(result.status ?? 500).json({ error:result.error });
});
router.post("/admin/deposits/:id/credit-bonus", requireUser, requireAdmin, async (_req,res) => res.status(409).json({error:"Le crédit de bonus doit être traité par le service de paiement"}));

  router.get("/admin/transactions", requireUser, requireAdmin, async (req,res) => { try { const limit=String(req.query.limit)==="all"?100000:Math.min(Math.max(Number(req.query.limit)||200,1),1000), offset=Math.max(Number(req.query.offset)||0,0), type=String(req.query.type||"all"), userId=String(req.query.user_id||"").trim(); const clauses:string[]=[];const args:unknown[]=[];if(type!=="all"){clauses.push("kind=?");args.push(type==="adjustment"?"deposit":type);}if(userId){if(!/^[0-9a-f-]{36}$/i.test(userId))return res.status(400).json({error:"user_id invalide"});clauses.push("user_id=?");args.push(userId);}const where=clauses.length?`WHERE ${clauses.join(" AND ")}`:""; const [rows]=await getMysqlPool().query<RowDataPacket[]>(`SELECT * FROM (SELECT CONCAT('o-',o.id) id,o.id local_order_id,'order' kind,o.created_at,o.charge_minor amount,o.status,o.refunded_at,o.refunded_amount_minor,o.user_id,COALESCE(p.username,p.email,o.user_id) user_label,p.email user_email,CONCAT_WS(' · ',o.service_category,o.service_name) detail,COALESCE(o.external_order_id,o.provider_order_id) reference,o.provider,p.country,o.currency FROM orders o LEFT JOIN profiles p ON p.user_id=o.user_id UNION ALL SELECT CONCAT('p-',x.id),NULL,'deposit',x.created_at,x.amount_minor,x.status,NULL,NULL,x.user_id,COALESCE(p.username,p.email,x.user_id),p.email,CONCAT('Dépôt · ',COALESCE(x.method,'')),COALESCE(x.transaction_id,x.order_id,x.provider_reference),NULL,x.country,x.currency FROM payments x LEFT JOIN profiles p ON p.user_id=x.user_id) t ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,[...args,limit,offset]); return res.json({rows:rows.map(r=>({...r,amount:Number(r.amount) / 100,refunded_amount:r.refunded_amount_minor==null?null:Number(r.refunded_amount_minor)/100})),total_count:null,has_more:rows.length===limit}); } catch (err) {logger.error({err},"transactions");return res.status(500).json({error:"Erreur lecture transactions"});} });

async function currencyOverrides(): Promise<Record<string, number>> { const [rows]=await getMysqlPool().query<RowDataPacket[]>("SELECT `key`,`value` FROM settings WHERE `key` LIKE 'currency_rate_%'"); return Object.fromEntries(rows.map(r=>[String(r.key).slice(14),Number(r.value)]).filter(([,v])=>Number.isFinite(Number(v)) && Number(v)>0)) as Record<string, number>; }
router.get("/admin/currencies", requireUser, requireAdmin, async (_req,res)=>{const o=await currencyOverrides();setRateOverrides(o);res.json({rates:NON_CFA_COUNTRIES_INFO.map(c=>({country:c.code,name:c.name,currency:c.currency,symbol:c.symbol,fcfaPerUnit:o[c.code]??c.defaultFcfaPerUnit,default:c.defaultFcfaPerUnit}))});});
router.put("/admin/currencies", requireUser, requireAdmin, async (req,res)=>{const country=String(req.body?.country||"").toUpperCase(), rate=Number(req.body?.fcfaPerUnit);if(!NON_CFA_COUNTRIES_INFO.some(c=>c.code===country)||!Number.isFinite(rate)||rate<=0)return res.status(400).json({error:"Taux ou pays invalide"});await putSetting(`currency_rate_${country}`,String(rate),(req as AuthedRequest).userId);setRateOverrides(await currencyOverrides());return res.json({ok:true,country,fcfaPerUnit:rate});});
router.delete("/admin/currencies/:country", requireUser, requireAdmin, async (req,res)=>{await getMysqlPool().execute("DELETE FROM settings WHERE `key`=?",[ `currency_rate_${String(req.params.country).toUpperCase()}` ]);setRateOverrides(await currencyOverrides());res.json({ok:true});});
async function savedUsdRates(){try{const v=await setting("smm_usd_rates");const x=v&&JSON.parse(v);return x?.default&&x?.peakerr?x as typeof USD_TO_LOCAL_RATES:null;}catch{return null;}}
export async function loadUsdRatesAtStartup(){const x=await savedUsdRates();if(x)setUsdRatesOverride(x);}
router.get("/admin/usd-rates", requireUser, requireAdmin, async (_req,res)=>{const x=await savedUsdRates();if(x)setUsdRatesOverride(x);res.json({rates:x??getUsdRates(),defaults:USD_TO_LOCAL_RATES});});
router.put("/admin/usd-rates", requireUser, requireAdmin, async (req,res)=>{const rates=req.body?.rates as typeof USD_TO_LOCAL_RATES;if(!rates?.default||!rates?.peakerr||![...Object.values(rates.default),...Object.values(rates.peakerr)].every(v=>typeof v==="number"&&v>0))return res.status(400).json({error:"Format invalide"});await putSetting("smm_usd_rates",JSON.stringify(rates),(req as AuthedRequest).userId);setUsdRatesOverride(rates);return res.json({ok:true,rates});});
router.delete("/admin/usd-rates", requireUser, requireAdmin, async (_req,res)=>{await getMysqlPool().execute("DELETE FROM settings WHERE `key`='smm_usd_rates'");clearUsdRatesOverride();res.json({ok:true});});

// Site-content stays operational data in MySQL; credentials are never accepted
// through these endpoints.
router.get("/site-content", async (_req,res) => {
  try {
    const [rows] = await getMysqlPool().query<RowDataPacket[]>("SELECT section,`key`,`value`,type,updated_at FROM site_content WHERE type IN ('text','image','url') ORDER BY section,`key`");
    return res.json({ content: rows });
  } catch (err) { logger.error({ err }, "public site content"); return res.status(500).json({ error: "Contenu indisponible" }); }
});
router.get("/admin/site-content", requireUser, requireAdmin, async (_req,res) => {
  const [rows] = await getMysqlPool().query<RowDataPacket[]>("SELECT id,section,`key`,label,`value`,type,updated_at FROM site_content ORDER BY section,`key`");
  res.json({ content: rows });
});
router.put("/admin/site-content/:key", requireUser, requireAdmin, async (req,res) => {
  const key=String(req.params.key || "").trim(), b=req.body || {}, section=String(b.section || "").trim(), value=typeof b.value === "string" ? b.value : null;
  if (!key || key.length>191 || !section || section.length>96 || value===null) return res.status(400).json({error:"Contenu invalide"});
  await getMysqlPool().execute(
    "INSERT INTO site_content (section,`key`,label,`value`,type,updated_by) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE section=VALUES(section),label=VALUES(label),`value`=VALUES(`value`),type=VALUES(type),updated_by=VALUES(updated_by)",
    [section,key,String(b.label || ""),value,String(b.type || "text"),(req as AuthedRequest).userId!],
  );
  return res.json({ok:true,key});
});
router.delete("/admin/site-content/:key", requireUser, requireAdmin, async (req,res) => {
  await getMysqlPool().execute("DELETE FROM site_content WHERE `key`=?",[req.params.key]);
  res.json({ok:true});
});
router.get("/admin/operator-logos", requireUser, requireAdmin, async (_req, res) => {
  const logos = await fetchOperatorLogos();
  return res.json({ operators: Object.entries(logos).map(([code, logo_url]) => ({ code, logo_url })) });
});
router.post("/admin/operator-logos/:code/upload", requireUser, requireAdmin, uploadLogo.single("logo"), async (req, res) => {
  const code = String(req.params.code || "");
  const file = req.file;
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(code) || !file || !["image/png", "image/jpeg", "image/svg+xml"].includes(file.mimetype)) return res.status(400).json({ error: "Image ou code opérateur invalide" });
  try { return res.json({ logo_url: await uploadOperatorLogoFile(code, file.buffer, file.mimetype) }); }
  catch (err) { logger.error({ err, code }, "operator logo upload"); return res.status(500).json({ error: "Enregistrement du logo impossible" }); }
});
router.delete("/admin/operator-logos/:code", requireUser, requireAdmin, async (req, res) => {
  const code = String(req.params.code || "");
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(code)) return res.status(400).json({ error: "Code opérateur invalide" });
  await deleteOperatorLogo(code); return res.json({ ok: true });
});

export default router;