#!/usr/bin/env node
// Local, one-time importer. Input JSON is intentionally never committed.
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";

const input = process.argv.slice(2).find((argument) => argument !== "--");
if (!input) throw new Error("Usage: pnpm --filter @workspace/api-server import:supabase-users <export.json>");
const required = ["MYSQL_HOST", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD"];
if (required.some((key) => !process.env[key])) {
  const configPath = path.join(path.dirname(path.resolve(input)), "mysql-import-config.json");
  let config;
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    throw new Error(
      `Required MYSQL_* configuration is missing. Add a private ${configPath} file beside the export.`,
    );
  }
  for (const key of [...required, "MYSQL_PORT"]) {
    if (!process.env[key] && config[key] !== undefined) {
      process.env[key] = String(config[key]);
    }
  }
}
if (required.some((key) => !process.env[key])) {
  throw new Error("Required MYSQL_* configuration is missing from mysql-import-config.json");
}
const raw = JSON.parse(await fs.readFile(input, "utf8"));
const records = Array.isArray(raw)
  ? (raw.length === 1 && Array.isArray(raw[0]?.export_data) ? raw[0].export_data : raw)
  : (Array.isArray(raw?.export_data) ? raw.export_data : raw?.users);
if (!Array.isArray(records)) {
  throw new Error("Export must be a JSON array, Supabase Copy as JSON result, or { users: [...] }");
}
const allocatedUsernames = new Set();
const usernameFor = (record) => {
  const email = typeof record.email === "string" ? record.email : "";
  const rawName =
    typeof record.username === "string" && record.username.trim()
      ? record.username.trim()
      : email.split("@")[0];
  const baseName = rawName.slice(0, 64);
  const normalized = baseName.toLocaleLowerCase();
  if (!allocatedUsernames.has(normalized)) {
    allocatedUsernames.add(normalized);
    return baseName;
  }
  const suffix = `-${String(record.id).slice(0, 8)}`;
  const uniqueName = `${baseName.slice(0, 64 - suffix.length)}${suffix}`;
  allocatedUsernames.add(uniqueName.toLocaleLowerCase());
  return uniqueName;
};
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306),
  database: process.env.MYSQL_DATABASE, user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
});
const mcf = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
let imported = 0;
try {
  for (const record of records) {
    const {
      id, email, encrypted_password: passwordHash, username, country, currency,
      balance, affiliate_earnings, avatar_url, referral_code, roles,
    } = record;
    if (typeof id !== "string" || !crypto.randomUUID || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid user UUID in export");
    if (typeof email !== "string" || !mcf.test(passwordHash) || !(await bcrypt.getRounds(passwordHash))) throw new Error("Invalid email or bcrypt password format in export");
    const name = usernameFor({ id, email, username });
    const balanceMinor = Math.round(Number(balance || 0) * 100);
    const affiliateEarningsMinor = Math.round(Number(affiliate_earnings || 0) * 100);
    if (!Number.isSafeInteger(balanceMinor) || !Number.isSafeInteger(affiliateEarningsMinor)) {
      throw new Error("Invalid monetary value in export");
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email)", [id, email.trim().toLowerCase(), passwordHash]);
      await connection.execute(
        "INSERT INTO profiles (user_id, email, username, country, currency, balance_minor, affiliate_earnings_minor, avatar_url, referral_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email), username = VALUES(username), country = COALESCE(VALUES(country), country), currency = COALESCE(VALUES(currency), currency), balance_minor = VALUES(balance_minor), affiliate_earnings_minor = VALUES(affiliate_earnings_minor), avatar_url = COALESCE(VALUES(avatar_url), avatar_url), referral_code = COALESCE(VALUES(referral_code), referral_code)",
        [id, email.trim().toLowerCase(), name, country || null, currency || null, balanceMinor, affiliateEarningsMinor, avatar_url || null, referral_code || null],
      );
      await connection.execute(
        "INSERT IGNORE INTO user_roles (user_id, role) VALUES (?, 'user')",
        [id],
      );
      // Roles are exported from public.user_roles (for example ["admin"]).
      // Never infer an elevated role from client-controlled profile fields.
      if (roles !== undefined && !Array.isArray(roles)) {
        throw new Error("roles must be an array when present");
      }
      for (const role of roles || []) {
        if (typeof role !== "string" || !/^[a-z_]{1,32}$/i.test(role)) {
          throw new Error("Invalid role in export");
        }
        await connection.execute(
          "INSERT IGNORE INTO user_roles (user_id, role) VALUES (?, ?)",
          [id, role.toLowerCase()],
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    imported++;
  }
  process.stdout.write(`Imported ${imported} users.\n`);
} finally {
  await pool.end();
}