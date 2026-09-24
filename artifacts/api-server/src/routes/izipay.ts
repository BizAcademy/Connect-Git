import crypto from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import type { RowDataPacket } from "mysql2/promise";
import { getMysqlPool } from "../lib/mysql";
import { logger } from "../lib/logger";
import { requireUser, type AuthedRequest } from "../lib/auth";
import { createIntent, parseUsdMinor, reconcileCryptoPayment, verifyIzipayWebhook } from "../lib/izipay";

const router: IRouter = Router();

router.post("/payments/crypto", requireUser, async (req: AuthedRequest, res) => {
  const amountMinor = parseUsdMinor(req.body?.amount);
  if (amountMinor == null || amountMinor < 100 || amountMinor > 1_000_000_00) return res.status(400).json({ error: "Montant USD invalide (1 à 1 000 000 USD)" });
  const origin = process.env["PUBLIC_API_URL"]?.replace(/\/+$/, "");
  if (!origin || !/^https:\/\//.test(origin) || !process.env["IZIPAY_API_KEY"] || !process.env["IZIPAY_WEBHOOK_SECRET"])
    return res.status(503).json({ error: "Paiement crypto non configuré" });
  const id = crypto.randomUUID();
  const reference = `BB-CR-${id}`;
  try {
    const [users] = await getMysqlPool().execute<RowDataPacket[]>("SELECT email FROM users WHERE id=?", [req.userId!]);
    await getMysqlPool().execute(
      "INSERT INTO payments (id,user_id,amount_minor,currency,status,provider,method,order_id,wallet_credited) VALUES (?,?,?,'USD','pending','izipay','crypto',?,'usd')",
      [id, req.userId!, amountMinor, reference],
    );
    const intent = await createIntent(amountMinor, reference, `${origin}/dashboard/deposit?crypto=${id}`, String(users[0]?.email ?? ""));
    const url = intent.paymentLink ?? intent.paymentUrl;
    if (!intent.id || !url || !/^https:\/\//.test(url)) throw new Error("Lien de paiement absent");
    await getMysqlPool().execute("UPDATE payments SET provider_reference=? WHERE id=? AND provider_reference IS NULL", [intent.id, id]);
    return res.json({ payment_id: id, payment_url: url });
  } catch (err) {
    logger.error({ err, paymentId: id }, "IziChange Pay intent creation failed");
    // Preserve pending records with an intent that may have been created remotely:
    // never overwrite them as failed if the provider response or DB update was ambiguous.
    return res.status(502).json({ error: "Impossible de créer le paiement crypto. Réessayez plus tard." });
  }
});

router.get("/payments/crypto/:id", requireUser, async (req: AuthedRequest, res) => {
  const id = String(req.params.id);
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>("SELECT id,status,provider_reference,credited_at FROM payments WHERE id=? AND user_id=? AND provider='izipay'", [id, req.userId!]);
  if (!rows[0]) return res.status(404).json({ error: "Paiement introuvable" });
  try {
    const status = rows[0].credited_at ? "completed" : rows[0].provider_reference ? await reconcileCryptoPayment(id) : String(rows[0].status);
    return res.json({ status, credited: status === "completed" });
  } catch (err) {
    logger.error({ err, paymentId: id }, "IziChange Pay status failed");
    return res.status(502).json({ error: "Vérification du paiement indisponible" });
  }
});

router.post("/payments/crypto/webhook", async (req: Request & { rawBody?: string }, res) => {
  let event: ReturnType<typeof verifyIzipayWebhook>;
  try {
    event = verifyIzipayWebhook(req.rawBody, req.headers["x-izipay-signature"] as string | undefined);
  } catch (err) {
    logger.warn({ err }, "IziChange Pay webhook rejected");
    return res.status(401).json({ error: "Signature invalide" });
  }
  if (!event.event.startsWith("payment_intent.")) return res.json({ received: true });
  try {
    const [rows] = await getMysqlPool().execute<RowDataPacket[]>("SELECT id FROM payments WHERE provider='izipay' AND provider_reference=?", [event.data.intentId]);
    if (!rows[0]) return res.status(503).json({ error: "Intention non enregistrée" });
    const status = await reconcileCryptoPayment(String(rows[0].id));
    logger.info({ paymentId: rows[0].id, status }, "IziChange Pay webhook processed");
    return res.json({ received: true });
  } catch (err) {
    logger.error({ err, intentId: event.data.intentId }, "IziChange Pay webhook processing failed");
    return res.status(503).json({ error: "Vérification indisponible" });
  }
});

export default router;