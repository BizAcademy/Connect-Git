#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requiredMysql = ["MYSQL_HOST", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD"];
const requiredSupabase = ["VITE_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const configPath = path.resolve(process.cwd(), "private-import/supabase-history-config.json");

async function loadPrivateConfig() {
  if (![...requiredMysql, ...requiredSupabase].some(key => !process.env[key])) return;
  try {
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    for (const key of [...requiredMysql, "MYSQL_PORT", ...requiredSupabase]) {
      if (!process.env[key] && config[key] !== undefined) process.env[key] = String(config[key]).trim();
    }
  } catch {}
}

await loadPrivateConfig();
if (requiredMysql.some(key => !process.env[key])) throw new Error("Configuration MYSQL_* manquante");
if (requiredSupabase.some(key => !process.env[key])) {
  throw new Error("Configuration Supabase manquante (VITE_SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY)");
}

const supabaseUrl = process.env.VITE_SUPABASE_URL.replace(/\/$/, "");
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST.trim(),
  port: Number((process.env.MYSQL_PORT || "3306").trim()),
  database: process.env.MYSQL_DATABASE.trim(),
  user: process.env.MYSQL_USER.trim(),
  password: process.env.MYSQL_PASSWORD,
  connectionLimit: 4,
});

async function fetchTable(table) {
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const response = await fetch(`${supabaseUrl}/rest/v1/${table}?select=*&order=created_at.asc&offset=${offset}&limit=${pageSize}`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Accept: "application/json" },
    });
    if (!response.ok) {
      const body = await response.text();
      const hint = response.status === 402
        ? "Le projet Supabase est suspendu ou sa facturation doit être réactivée."
        : body.slice(0, 300);
      throw new Error(`Supabase ${table}: HTTP ${response.status}. ${hint}`);
    }
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error(`Réponse Supabase invalide pour ${table}`);
    rows.push(...page);
    process.stdout.write(`${table}: ${rows.length} ligne(s) lue(s)\n`);
    if (page.length < pageSize) break;
  }
  return rows;
}

const minor = value => {
  const result = Math.round(Number(value || 0) * 100);
  if (!Number.isSafeInteger(result)) throw new Error("Montant historique invalide");
  return result;
};

async function main() {
  const [orders, payments] = await Promise.all([fetchTable("orders"), fetchTable("payments")]);
  const [userRows] = await pool.query("SELECT id FROM users");
  const users = new Set(userRows.map(row => String(row.id)));
  const stats = {
    orders: { source: orders.length, inserted: 0, existing: 0, missingUser: 0, invalid: 0 },
    payments: { source: payments.length, inserted: 0, existing: 0, missingUser: 0, invalid: 0 },
  };
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const order of orders) {
      if (!UUID_RE.test(String(order.id || "")) || !UUID_RE.test(String(order.user_id || ""))) { stats.orders.invalid++; continue; }
      if (!users.has(String(order.user_id))) { stats.orders.missingUser++; continue; }
      const [result] = await connection.execute(
        `INSERT IGNORE INTO orders
         (id,user_id,provider_order_id,external_order_id,provider,service_name,service_category,link,
          quantity,charge_minor,currency,status,refunded_at,refunded_amount_minor,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          order.id, order.user_id, order.external_order_id || null, order.external_order_id || null,
          Number(order.provider) || 1, String(order.service_name || ""), String(order.service_category || ""),
          String(order.link || ""), Math.max(0, Math.round(Number(order.quantity) || 0)), minor(order.price),
          "XOF", String(order.status || "pending").toLowerCase(), order.refunded_at || null,
          order.refunded_amount == null ? null : minor(order.refunded_amount),
          order.created_at || new Date().toISOString(), order.updated_at || order.created_at || new Date().toISOString(),
        ],
      );
      if (result.affectedRows) stats.orders.inserted++; else stats.orders.existing++;
    }
    for (const payment of payments) {
      if (!UUID_RE.test(String(payment.id || "")) || !UUID_RE.test(String(payment.user_id || ""))) { stats.payments.invalid++; continue; }
      if (!users.has(String(payment.user_id))) { stats.payments.missingUser++; continue; }
      const reference = payment.reference || payment.transaction_id || payment.order_id || null;
      const [result] = await connection.execute(
        `INSERT IGNORE INTO payments
         (id,user_id,provider_reference,reference,amount_minor,currency,status,provider,method,order_id,
          transaction_id,country,operator,phone_number,credited_at,completed_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          payment.id, payment.user_id, reference, payment.reference || null, minor(payment.amount),
          String(payment.currency || "XOF").toUpperCase(), String(payment.status || "pending").toLowerCase(),
          "supabase_archive", String(payment.method || "mobile_money"), payment.order_id || null,
          payment.transaction_id || null, payment.country || null, payment.operator || null,
          payment.phone_number || null,
          String(payment.status).toLowerCase() === "completed" ? payment.created_at : null,
          String(payment.status).toLowerCase() === "completed" ? payment.created_at : null,
          payment.created_at || new Date().toISOString(), payment.created_at || new Date().toISOString(),
        ],
      );
      if (result.affectedRows) stats.payments.inserted++; else stats.payments.existing++;
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
  process.stdout.write("Import historique terminé. Les nouvelles transactions restent exclusivement dans MySQL.\n");
}

try { await main(); }
finally { await pool.end(); }