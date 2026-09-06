import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMysqlPool } from "../lib/mysql";
import type { RowDataPacket } from "mysql2/promise";

async function main() {
  const pool = getMysqlPool();
  await pool.query("SELECT 1");
  const [rows] = await pool.query<(RowDataPacket & { TABLE_NAME: string })[]>(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()",
  );
  if (rows.length > 0) {
    throw new Error("Refusing migration: target schema is not empty");
  }
  const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations/mysql");
  const sql = await fs.readFile(path.join(directory, "001_bizpanel_auth_phase1.sql"), "utf8");
  await pool.query(sql);
  await pool.end();
}

main().catch((err) => {
  process.stderr.write(`MySQL migration failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
  process.exitCode = 1;
});