import crypto from "node:crypto";
import { Router, type IRouter, type Response, type NextFunction } from "express";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { logger } from "../lib/logger";
import { getMysqlPool } from "../lib/mysql";
import { requireUser, requireAdmin, type AuthedRequest } from "../lib/auth";
import { enrichServices, defaultPriceFcfaForCurrency, loadPricing, getUsdRates } from "../lib/smm-pricing";
import { callProvider, getProvider, parseProviderId, ALL_PROVIDER_IDS, loadProviderConfig, type ProviderId } from "../lib/smm-providers";
import { FINAL_REFUND_STATUSES, mapProviderStatus, isSupportedServiceType } from "../lib/smm-status";
import { appendEarning, estimateGainFromRevenue } from "../lib/earnings";

const router: IRouter = Router();
const CACHE_TTL_MS = 30 * 60_000;
const svcCache = new Map<number, { ts: number; data: any[] }>();
const enrichedCache = new Map<number, { ts: number; services: any[]; etag: string }>();
const orderHits = new Map<string, { count: number; resetAt: number }>();
const COUNTRY_TO_CURRENCY: Record<string, string> = { BJ:"XOF",BF:"XOF",CI:"XOF",GW:"XOF",ML:"XOF",NE:"XOF",SN:"XOF",TG:"XOF",CM:"XAF",CF:"XAF",TD:"XAF",CG:"XAF",GQ:"XAF",GA:"XAF",CD:"CDF",GN:"GNF",GM:"GMD" };
const fcfaToMinor = (value: number) => Math.round(value * 100);
const minorToFcfa = (value: unknown) => Number(value || 0) / 100;

async function getRawServices(providerId: ProviderId): Promise<any[]> {
  const hit = svcCache.get(providerId); if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;
  const data = await callProvider(providerId, "services"); svcCache.set(providerId, { ts: Date.now(), data }); return data;
}
async function getEnrichedServices(providerId: ProviderId) {
  const hit = enrichedCache.get(providerId); if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit;
  const services = (await enrichServices(await getRawServices(providerId), providerId)).filter(s => !s.hidden && isSupportedServiceType(s.type));
  const result = { ts: Date.now(), services, etag: `"${providerId}-${Date.now()}"` }; enrichedCache.set(providerId, result); return result;
}
export async function warmServicesCache() { for (const id of ALL_PROVIDER_IDS) try { await getEnrichedServices(id as ProviderId); } catch (err) { logger.warn({ err, id }, "services cache warm failed"); } }
function rateLimitOrders(req: AuthedRequest, res: Response, next: NextFunction) {
  const key = req.userId || req.ip || "anon", now = Date.now(), hit = orderHits.get(key);
  if (!hit || hit.resetAt < now) { orderHits.set(key, { count: 1, resetAt: now + 60_000 }); return next(); }
  if (hit.count >= 10) return res.status(429).json({ error: "Trop de commandes, réessayez dans 1 minute" });
  hit.count++; next();
}
async function profile(userId: string) {
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>("SELECT country, currency, balance_minor FROM profiles WHERE user_id = ? LIMIT 1", [userId]);
  return rows[0] ?? null;
}
function currency(country: string | null, configured: string | null) { return configured || (country ? COUNTRY_TO_CURRENCY[country.toUpperCase()] : undefined) || "XOF"; }
function orderView(row: RowDataPacket) {
  return { ...row, price: minorToFcfa(row.charge_minor), balance_before: row.balance_before_minor == null ? null : minorToFcfa(row.balance_before_minor), balance_after: row.balance_after_minor == null ? null : minorToFcfa(row.balance_after_minor), external_order_id: row.external_order_id ?? row.provider_order_id };
}

/** Credits a negative order exactly once while holding both order and profile locks. */
export async function refundOrderAtomic(orderId: string, requestedMinor?: number) {
  const conn = await getMysqlPool().getConnection();
  try {
    await conn.beginTransaction();
    const [orders] = await conn.execute<RowDataPacket[]>("SELECT * FROM orders WHERE id = ? FOR UPDATE", [orderId]);
    const order = orders[0]; if (!order || order.refunded_at) { await conn.rollback(); return { refunded: false, amountMinor: 0 }; }
    const amount = Math.max(0, Math.min(Math.round(requestedMinor ?? Number(order.charge_minor)), Number(order.charge_minor)));
    if (!amount) { await conn.rollback(); return { refunded: false, amountMinor: 0 }; }
    const [profiles] = await conn.execute<RowDataPacket[]>("SELECT balance_minor FROM profiles WHERE user_id = ? FOR UPDATE", [order.user_id]);
    if (!profiles[0]) throw new Error("Profile introuvable");
    const before = Number(profiles[0].balance_minor), after = before + amount, now = new Date();
    await conn.execute("UPDATE profiles SET balance_minor = ? WHERE user_id = ?", [after, order.user_id]);
    await conn.execute("UPDATE orders SET refunded_at = ?, refunded_amount_minor = ? WHERE id = ?", [now, amount, order.id]);
    await conn.execute("INSERT INTO wallet_transactions (id,user_id,amount_minor,balance_after_minor,currency,type,reference_type,reference_id) VALUES (?,?,?,?,?,'refund','order',?)", [crypto.randomUUID(), order.user_id, amount, after, order.currency, order.id]);
    await conn.execute("INSERT INTO balance_audit_log (user_id,previous_balance_minor,new_balance_minor,reason) VALUES (?,?,?,'smm_order_refund')", [order.user_id, before, after]);
    await conn.commit(); return { refunded: true, amountMinor: amount, newBalanceMinor: after, userId: String(order.user_id) };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
}
async function debitAndCreate(input: { userId: string; provider: number; service: number; name: string; category: string; link: string; quantity: number; chargeMinor: number; currency: string; clientRequestId: string }) {
  const conn = await getMysqlPool().getConnection(), id = crypto.randomUUID();
  try {
    await conn.beginTransaction();
    const [profiles] = await conn.execute<RowDataPacket[]>("SELECT balance_minor FROM profiles WHERE user_id = ? FOR UPDATE", [input.userId]);
    const p = profiles[0]; if (!p) throw Object.assign(new Error("Profil introuvable"), { code: "PROFILE" });
    const before = Number(p.balance_minor); if (before < input.chargeMinor) throw Object.assign(new Error("Solde insuffisant. Rechargez votre compte."), { code: "FUNDS" });
    const after = before - input.chargeMinor;
    await conn.execute("UPDATE profiles SET balance_minor = ? WHERE user_id = ?", [after, input.userId]);
    await conn.execute(`INSERT INTO orders (id,user_id,provider,service_id,service_name,service_category,link,quantity,charge_minor,currency,balance_before_minor,balance_after_minor,client_request_id,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending')`, [id,input.userId,input.provider,String(input.service),input.name,input.category,input.link,input.quantity,input.chargeMinor,input.currency,before,after,input.clientRequestId]);
    await conn.execute("INSERT INTO wallet_transactions (id,user_id,amount_minor,balance_after_minor,currency,type,reference_type,reference_id) VALUES (?,?,?,?,?,'order_debit','order',?)", [crypto.randomUUID(),input.userId,-input.chargeMinor,after,input.currency,id]);
    await conn.execute("INSERT INTO balance_audit_log (user_id,previous_balance_minor,new_balance_minor,reason) VALUES (?,?,?,'smm_order_debit')", [input.userId,before,after]);
    await conn.commit(); return { id, before, after };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
}
async function compensateFailedPlacement(orderId: string): Promise<void> {
  // Mark first: if the immediate compensating transaction has a transient
  // database failure, the missed-refund scanner can safely retry this order.
  await getMysqlPool().execute("UPDATE orders SET status = 'failed' WHERE id = ?", [orderId]);
  try { await refundOrderAtomic(orderId); }
  catch (err) { logger.error({ err, orderId }, "order placement compensation deferred to refund scanner"); }
}

router.get("/smm/providers", async (_req, res) => { try { const cfg = await loadProviderConfig(); res.json({ providers: cfg.filter(p => p.enabled && getProvider(p.provider_id)?.configured).map(p => ({ provider_id:p.provider_id, display_order:p.display_order, header_title:p.header_title, header_text:p.header_text })) }); } catch (err) { res.status(500).json({ error:(err as Error).message }); } });
router.get("/smm/currency-rates", (_req, res) => { res.set("Cache-Control", "no-store"); res.json({ usd_rates:getUsdRates() }); });
router.get("/smm/popular-services", async (req, res) => {
  const provider = parseProviderId(req.query["provider"]);
  try { const [rows] = await getMysqlPool().execute<RowDataPacket[]>("SELECT service_name FROM orders WHERE provider = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 2000", [provider]); const scores: Record<string,number> = {}; rows.forEach(r => { const k=String(r.service_name||"").trim().toLowerCase(); if(k) scores[k]=(scores[k]||0)+1; }); res.json({ scores, provider }); } catch (err) { logger.error({err},"popular-services failed"); res.json({scores:{},provider}); }
});
router.get("/smm/services", async (req,res) => { const provider=parseProviderId(req.query["provider"]); try { const data=await getEnrichedServices(provider); res.setHeader("Cache-Control","public, max-age=300, stale-while-revalidate=1800"); res.setHeader("ETag",data.etag); if(req.headers["if-none-match"]===data.etag) return res.sendStatus(304); return res.json({services:data.services,provider}); } catch(err) { return res.status(500).json({error:(err as Error).message}); } });
router.get("/smm/balance",requireUser,requireAdmin,async(req,res)=>{const provider=parseProviderId(req.query["provider"]);try{res.json({...await callProvider(provider,"balance"),provider});}catch(err){res.status(500).json({error:(err as Error).message});}});

router.post("/smm/order", requireUser, rateLimitOrders, async (req: AuthedRequest, res) => {
  const { service, link, quantity, provider } = req.body || {}, providerId = parseProviderId(provider), serviceNum = Number(service), qty = Number(quantity), linkStr = typeof link === "string" ? link.trim() : "";
  const suppliedRequestId = typeof req.body?.client_request_id === "string" ? req.body.client_request_id.trim() : "";
  const clientRequestId = suppliedRequestId || crypto.randomUUID();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(clientRequestId)) return res.status(400).json({ error: "client_request_id invalide" });
  if (!Number.isInteger(serviceNum) || serviceNum <= 0) return res.status(400).json({error:"service invalide"});
  if (!Number.isInteger(qty) || qty < 1 || qty > 10_000_000) return res.status(400).json({error:"quantity invalide (1 — 10 000 000)"});
  if (!/^https?:\/\//i.test(linkStr) || linkStr.length > 500) return res.status(400).json({error:"link doit être une URL http(s) valide"});
  if (!getProvider(providerId)?.configured) return res.status(400).json({error:`Fournisseur SMM #${providerId} non configuré`});
  try {
    const [existingRows] = await getMysqlPool().execute<RowDataPacket[]>("SELECT * FROM orders WHERE user_id=? AND client_request_id=? LIMIT 1", [req.userId!, clientRequestId]);
    if (existingRows[0]) {
      const existing = existingRows[0];
      return res.json({ order: existing.provider_order_id ?? existing.external_order_id ?? undefined, provider: Number(existing.provider), local_order_id: String(existing.id), status: String(existing.status), reused: true });
    }
    const config=(await loadProviderConfig()).find(c=>c.provider_id===providerId); if(config && !config.enabled) return res.status(403).json({error:`Fournisseur SMM #${providerId} actuellement désactivé`});
    const svc=(await getRawServices(providerId)).find((s:any)=>Number(s.service)===serviceNum); if(!svc) return res.status(404).json({error:"Service introuvable"}); if(!isSupportedServiceType(svc.type)) return res.status(400).json({error:"Type de service non supporté (paramètres additionnels requis)"});
    const override=(await loadPricing(providerId))[String(serviceNum)]; if(override?.hidden) return res.status(403).json({error:"Service non disponible"});
    const p=await profile(req.userId!); if(!p) return res.status(500).json({error:"Impossible de lire votre solde"});
    const priceFcfa=typeof override?.price_fcfa==="number"?override.price_fcfa:defaultPriceFcfaForCurrency(svc.rate,providerId,currency(p.country,p.currency));
    const totalFcfa=Math.ceil(qty/1000*priceFcfa), chargeMinor=fcfaToMinor(totalFcfa);
    let created: {id:string;before:number;after:number};
    try { created=await debitAndCreate({userId:req.userId!,provider:providerId,service:serviceNum,name:String(svc.name??serviceNum),category:String(svc.category??""),link:linkStr,quantity:qty,chargeMinor,currency:currency(p.country,p.currency),clientRequestId}); } catch(err:any) {
      if (err?.code === "ER_DUP_ENTRY") {
        const [duplicate] = await getMysqlPool().execute<RowDataPacket[]>("SELECT * FROM orders WHERE user_id=? AND client_request_id=? LIMIT 1", [req.userId!, clientRequestId]);
        if (duplicate[0]) return res.json({ order: duplicate[0].provider_order_id ?? duplicate[0].external_order_id ?? undefined, provider: Number(duplicate[0].provider), local_order_id: String(duplicate[0].id), status: String(duplicate[0].status), reused: true });
      }
      return res.status(err.code==="FUNDS"?402:500).json({error:err.message});
    }
    let providerData:any; try { providerData=await callProvider(providerId,"add",{service:serviceNum,link:linkStr,quantity:qty}); } catch(err) {
      await getMysqlPool().execute("UPDATE orders SET status='reconciliation_required' WHERE id=?", [created.id]);
      logger.warn({ err, orderId: created.id, providerId }, "provider submission outcome unknown; retained for reconciliation");
      return res.status(202).json({ error:"Soumission en cours de vérification; votre solde reste réservé.", provider:providerId, local_order_id:created.id, status:"reconciliation_required" });
    }
    if(providerData?.error) { await compensateFailedPlacement(created.id); const msg=String(providerData.error); return res.status(/not\s*enough\s*funds|insufficient\s*(funds|balance)|solde\s*insuffisant/i.test(msg)?503:502).json(/not\s*enough\s*funds|insufficient\s*(funds|balance)|solde\s*insuffisant/i.test(msg)?{error:"SERVICE MOMENTANÉMENT INDISPONIBLE VEILLEZ CHANGER DE FOURNISSEURS",provider_unavailable:true}:{error:msg||"Le fournisseur n'a pas accepté la commande"}); }
    const external=String(providerData.order??providerData.id??""); if(!external) {
      await getMysqlPool().execute("UPDATE orders SET status='reconciliation_required' WHERE id=?", [created.id]);
      return res.status(202).json({ error:"Réponse fournisseur ambiguë; commande en vérification.", provider:providerId, local_order_id:created.id, status:"reconciliation_required" });
    }
    await getMysqlPool().execute("UPDATE orders SET provider_order_id=?, external_order_id=?, status='processing' WHERE id=?", [external,external,created.id]);
    return res.json({...providerData,provider:providerId,local_order_id:created.id});
  } catch(err) { logger.error({err,userId:req.userId!,providerId},"SMM order error"); return res.status(500).json({error:"Erreur interne lors de la commande"}); }
});
router.get("/smm/user-orders",requireUser,async(req:AuthedRequest,res)=>{try{const [rows]=await getMysqlPool().execute<RowDataPacket[]>("SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC",[req.userId!]);res.json(rows.map(orderView));}catch(err){req.log.error({err},"user-orders failed");res.json([]);}});
router.get("/smm/dashboard-summary",requireUser,async(req:AuthedRequest,res)=>{
  try{
    const [[statsRows],[recentRows]]=await Promise.all([
      getMysqlPool().execute<RowDataPacket[]>(
        `SELECT COUNT(*) AS total,
          COALESCE(SUM(status IN ('pending','processing')),0) AS pending,
          COALESCE(SUM(status='completed'),0) AS completed
         FROM orders WHERE user_id=?`,
        [req.userId!],
      ),
      getMysqlPool().execute<RowDataPacket[]>(
        `SELECT id,provider,service_id,service_name,service_category,link,quantity,
          charge_minor,currency,status,provider_order_id,external_order_id,created_at,updated_at
         FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 6`,
        [req.userId!],
      ),
    ]);
    const stats=statsRows[0]??{};
    return res.json({
      stats:{
        total:Number(stats.total??0),
        pending:Number(stats.pending??0),
        completed:Number(stats.completed??0),
      },
      recent_orders:recentRows.map(orderView),
    });
  }catch(err){
    req.log.error({err},"dashboard-summary failed");
    return res.status(500).json({error:"Impossible de charger le tableau de bord"});
  }
});
router.get("/smm/user-payments",requireUser,async(req:AuthedRequest,res)=>{try{const [rows]=await getMysqlPool().execute<RowDataPacket[]>("SELECT *, amount_minor / 100 AS amount, fee_minor / 100 AS fee, bonus_amount_minor / 100 AS bonus_amount, charge_minor / 100 AS charge FROM payments WHERE user_id=? ORDER BY created_at DESC",[req.userId!]);res.json(rows);}catch(err){req.log.error({err},"user-payments failed");res.json([]);}});
router.get("/smm/quote",requireUser,async(req:AuthedRequest,res)=>{const provider=parseProviderId(req.query["provider"]), service=Number(req.query["service"]), quantity=Number(req.query["quantity"]);if(!Number.isInteger(service)||service<=0)return res.status(400).json({error:"service invalide"});if(!Number.isInteger(quantity)||quantity<1)return res.status(400).json({error:"quantity invalide"});try{const svc=(await getRawServices(provider)).find((s:any)=>Number(s.service)===service);if(!svc)return res.status(404).json({error:"service introuvable"});const ov=(await loadPricing(provider))[String(service)];if(ov?.hidden)return res.status(403).json({error:"Service non disponible"});const p=await profile(req.userId!);const custom=typeof ov?.price_fcfa === "number";const per=custom?ov!.price_fcfa:defaultPriceFcfaForCurrency(svc.rate,provider,currency(p?.country??null,p?.currency??null));return res.json({service,provider,quantity,price_per_1000_fcfa:per,total_fcfa:Math.ceil(quantity/1000*per),price_is_custom:custom});}catch(err){return res.status(500).json({error:(err as Error).message});}});
router.get("/smm/status",requireUser,async(req:AuthedRequest,res)=>{const external=String(req.query["order"]||""),provider=parseProviderId(req.query["provider"]);if(!external)return res.status(400).json({error:"order id required"});try{const [rows]=await getMysqlPool().execute<RowDataPacket[]>("SELECT user_id FROM orders WHERE provider=? AND (provider_order_id=? OR external_order_id=?) LIMIT 1",[provider,external,external]);if(!rows[0]||String(rows[0].user_id)!==req.userId)return res.status(403).json({error:"Commande introuvable ou accès refusé"});return res.json({...await callProvider(provider,"status",{order:external}),provider});}catch(err){return res.status(500).json({error:(err as Error).message});}});

export async function syncOrderInternal(opts:{localOrderId?:string;externalId?:string;providerId?:ProviderId;expectedUserId?:string;forceRefund?:boolean}):Promise<any>{
  if(!opts.localOrderId&&!(opts.externalId&&opts.providerId))return{ok:false,status:400,error:"syncOrderInternal: localOrderId ou (externalId + providerId) requis"};
  const sql=opts.localOrderId?"SELECT * FROM orders WHERE id=? LIMIT 1":"SELECT * FROM orders WHERE provider=? AND (provider_order_id=? OR external_order_id=?) LIMIT 1";
  const args=opts.localOrderId?[opts.localOrderId]:[opts.providerId!,opts.externalId!,opts.externalId!]; const [rows]=await getMysqlPool().execute<RowDataPacket[]>(sql,args); const order=rows[0];if(!order)return{ok:false,status:404,error:"Commande introuvable"};if(opts.expectedUserId&&String(order.user_id)!==opts.expectedUserId)return{ok:false,status:403,error:"Accès refusé"};
  const provider=Number(order.provider) as ProviderId, external=String(order.provider_order_id??order.external_order_id??"");
  // A reconciliation queue row has no provider id by definition. It must stay
  // visible until an admin either attaches a confirmed id or explicitly
  // refunds it; do not attempt a fabricated provider lookup.
  if(!external&&!opts.forceRefund)return{ok:false,status:409,error:"Commande en réconciliation: identifiant fournisseur requis"};
  let status=opts.forceRefund?"refunded":String(order.status), remains:number|undefined;
  if(!opts.forceRefund)try{const data:any=await callProvider(provider,"status",{order:external});if(data?.error)return{ok:false,status:502,error:String(data.error)};status=mapProviderStatus(data?.status)||status;if(data?.remains!=null&&Number.isFinite(Number(data.remains)))remains=Number(data.remains);}catch{return{ok:false,status:502,error:"Fournisseur SMM injoignable"};}
  // Earnings are recognition, not placement revenue: write only after the
  // provider has confirmed completion. The database's (provider,
  // provider_order_id) unique key makes concurrent poller/manual sync calls
  // idempotent.
  if(status==="completed"&&external){
    const revenueFcfa=minorToFcfa(order.charge_minor);
    const gain=estimateGainFromRevenue(revenueFcfa);
    await appendEarning({
      ts:new Date().toISOString(), provider_order_id:external, user_id:String(order.user_id),
      service:Number(order.service_id)||0, service_name:String(order.service_name??""),
      quantity:Number(order.quantity)||0, rate_usd:0, user_price_fcfa:revenueFcfa,
      provider_cost_usd:0, ...gain, provider, order_id:String(order.id), currency:String(order.currency??"XOF"),
    });
  }
  // Persist completed status only after its durable earning has been accepted;
  // otherwise a subsequent poll/manual sync can retry the ledger write.
  if(status!==order.status)await getMysqlPool().execute("UPDATE orders SET status=? WHERE id=?",[status,order.id]);
  let refund:any={refunded:false,amountMinor:0};if((FINAL_REFUND_STATUSES.has(status)||status==="partial"||opts.forceRefund)&&!order.refunded_at){let amount=Number(order.charge_minor);if(status==="partial"&&!opts.forceRefund)amount=remains&&Number(order.quantity)>0?Math.round(remains/Number(order.quantity)*amount):0;if(amount>0)refund=await refundOrderAtomic(String(order.id),amount);}
  return{ok:true,status,previous_status:String(order.status),refunded:refund.refunded,refunded_amount:refund.refunded?minorToFcfa(refund.amountMinor):undefined,user_id:String(order.user_id),provider};
}
function pquery(q:unknown):ProviderId|null{const n=Number(q);return n===1||n===3||n===4||n===5?n as ProviderId:null;}
async function syncRoute(req:AuthedRequest,res:Response, admin:boolean, refund=false){const external=String(req.params["externalId"]||""),provider=pquery(req.query["provider"]);if(!external||!provider)return res.status(400).json({error:!external?"externalId requis":"provider requis (1, 3, 4 ou 5)"});const r=await syncOrderInternal({externalId:external,providerId:provider,expectedUserId:admin?undefined:req.userId,forceRefund:refund});return r.ok?res.json(r):res.status(r.status).json({error:r.error});}
router.post("/smm/orders/:externalId/sync",requireUser,(req,res)=>syncRoute(req as AuthedRequest,res,false));
router.post("/admin/orders/:externalId/sync",requireUser,requireAdmin,(req,res)=>syncRoute(req as AuthedRequest,res,true));
router.post("/admin/orders/:externalId/refund",requireUser,requireAdmin,(req,res)=>syncRoute(req as AuthedRequest,res,true,true));
router.post("/admin/orders/:externalId/cancel",requireUser,requireAdmin,async(req,res)=>{const external=String(req.params["externalId"]||""),provider=pquery(req.query["provider"]);if(!external||!provider)return res.status(400).json({error:"externalId et provider requis"});let provider_cancel:any;try{provider_cancel={ok:true,raw:await callProvider(provider,"cancel",{orders:external})};}catch(err){provider_cancel={ok:false,error:(err as Error).message};}const r=await syncOrderInternal({externalId:external,providerId:provider,forceRefund:true});return r.ok?res.json({...r,provider_cancel}):res.status(r.status).json({error:r.error,provider_cancel});});
router.post("/admin/orders/by-id/:id/refund",requireUser,requireAdmin,async(req,res)=>{const r=await syncOrderInternal({localOrderId:String(req.params["id"]||""),forceRefund:true});return r.ok?res.json(r):res.status(r.status).json({error:r.error});});
// Operational reconciliation queue. No provider "client reference" is
// assumed: admins attach only an id they have independently confirmed.
router.get("/admin/orders",requireUser,requireAdmin,async(req,res)=>{
  const status=String(req.query["status"]||"reconciliation_required"),limit=Math.min(Math.max(Number(req.query["limit"])||200,1),1000);
  const [rows]=await getMysqlPool().execute<RowDataPacket[]>(
    "SELECT id,user_id,provider,service_id,service_name,quantity,charge_minor,currency,status,provider_order_id,external_order_id,created_at,updated_at FROM orders WHERE status=? ORDER BY created_at ASC LIMIT ?",
    [status,limit],
  );
  return res.json({orders:rows.map(orderView),status,count:rows.length});
});
router.post("/admin/orders/by-id/:id/attach-provider-order",requireUser,requireAdmin,async(req,res)=>{
  const id=String(req.params["id"]||""), external=String(req.body?.provider_order_id??req.body?.external_order_id??"").trim();
  if(!external||external.length>128)return res.status(400).json({error:"provider_order_id confirmé requis (1–128 caractères)"});
  const [orders]=await getMysqlPool().execute<RowDataPacket[]>("SELECT id,status FROM orders WHERE id=? LIMIT 1",[id]);
  if(!orders[0])return res.status(404).json({error:"Commande introuvable"});
  if(String(orders[0].status)!=="reconciliation_required")return res.status(409).json({error:"Seules les commandes en réconciliation peuvent recevoir un identifiant fournisseur"});
  try{
    await getMysqlPool().execute("UPDATE orders SET provider_order_id=?,external_order_id=?,status='processing' WHERE id=?",[external,external,id]);
  }catch(err:any){
    if(err?.code==="ER_DUP_ENTRY")return res.status(409).json({error:"Cet identifiant fournisseur est déjà associé à une commande"});
    throw err;
  }
  const result=await syncOrderInternal({localOrderId:id});
  return result.ok?res.json({ok:true,attached_provider_order_id:external,...result}):res.status(result.status).json({ok:false,attached_provider_order_id:external,error:result.error});
});
export function invalidateServicesCache(providerId?:number){if(providerId!==undefined){svcCache.delete(providerId);enrichedCache.delete(providerId);}else{svcCache.clear();enrichedCache.clear();}}
export { ALL_PROVIDER_IDS };
export default router;