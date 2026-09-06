/*
 * Opt-in MariaDB integration check. It never calls a provider and refuses to
 * run unless the configured database is explicitly named as a test database.
 * Run: MYSQL_INTEGRATION_TEST=1 MYSQL_TEST_DATABASE=my_test_db
 *      pnpm test:integration:money-earnings
 */
import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { createPayment } from "../lib/deposits";
import { appendEarning, findEarning } from "../lib/earnings";
import { closeMysqlPool } from "../lib/mysql";

if (process.env.MYSQL_INTEGRATION_TEST !== "1") throw new Error("Refusing database write: set MYSQL_INTEGRATION_TEST=1");
if (!process.env.MYSQL_TEST_DATABASE || process.env.MYSQL_DATABASE !== process.env.MYSQL_TEST_DATABASE) throw new Error("MYSQL_DATABASE must exactly match explicit MYSQL_TEST_DATABASE");
const required = ["MYSQL_HOST", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD"];
if (required.some((key) => process.env[key] === undefined)) throw new Error("MYSQL_* test configuration is incomplete");

const suffix = crypto.randomUUID(), userId = crypto.randomUUID(), paymentOrderId = `integration-${suffix}`, providerOrderId = `provider-${suffix}`;
const pool = mysql.createPool({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), database: process.env.MYSQL_DATABASE, user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD });
try {
  await pool.execute("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [userId, `${suffix}@integration.invalid`, "not-a-login"]);
  await pool.execute("INSERT INTO profiles (user_id,email,username) VALUES (?,?,?)", [userId, `${suffix}@integration.invalid`, `it-${suffix.slice(0, 12)}`]);
  const paymentId = await createPayment({ userId, amount: 500, feeAmount: 10, chargeAmount: 510, orderId: paymentOrderId, country: "SN", operator: "test", phoneNumber: "770000000", currency: "XOF" });
  const [paymentRows] = await pool.execute<any[]>("SELECT amount_minor,fee_minor,charge_minor FROM payments WHERE id=?", [paymentId]);
  const payment = paymentRows[0];
  if (!payment || Number(payment.amount_minor) !== 50000 || Number(payment.fee_minor) !== 1000 || Number(payment.charge_minor) !== 51000) throw new Error("payment minor-unit persistence assertion failed");
  const rec = { ts: new Date().toISOString(), provider_order_id: providerOrderId, user_id: userId, service: 1, service_name: "integration", quantity: 1000, rate_usd: 0, user_price_fcfa: 500, provider_cost_usd: 0, provider_cost_fcfa: 400, gain_fcfa: 100, provider: 1 };
  await appendEarning(rec); await appendEarning(rec);
  const [countRows] = await pool.execute<any[]>("SELECT COUNT(*) count FROM earnings WHERE provider=? AND provider_order_id=?", [1, providerOrderId]);
  const earning = await findEarning(providerOrderId, 1);
  if (Number(countRows[0].count) !== 1 || !earning || earning.user_price_fcfa !== 500 || earning.gain_fcfa !== 100) throw new Error("earnings idempotency/display conversion assertion failed");
  console.log("integration-money-earnings: passed");
} finally {
  await pool.execute("DELETE FROM earnings WHERE provider_order_id=?", [providerOrderId]).catch(() => undefined);
  await pool.execute("DELETE FROM payments WHERE order_id=?", [paymentOrderId]).catch(() => undefined);
  await pool.execute("DELETE FROM profiles WHERE user_id=?", [userId]).catch(() => undefined);
  await pool.execute("DELETE FROM users WHERE id=?", [userId]).catch(() => undefined);
  await pool.end();
  await closeMysqlPool();
}