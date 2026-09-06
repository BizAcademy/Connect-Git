import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    

// src/scripts/migrate-mysql.ts
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/lib/mysql.ts
import mysql from "mysql2/promise";
var pool;
function config() {
  const host = process.env["MYSQL_HOST"];
  const database = process.env["MYSQL_DATABASE"];
  const user = process.env["MYSQL_USER"];
  const password = process.env["MYSQL_PASSWORD"];
  const rawPort = process.env["MYSQL_PORT"];
  if (!host || !database || !user || password === void 0) {
    throw new Error("MYSQL_HOST, MYSQL_DATABASE, MYSQL_USER and MYSQL_PASSWORD are required");
  }
  const port = rawPort ? Number(rawPort) : 3306;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MYSQL_PORT must be a valid TCP port");
  }
  return { host, port, database, user, password, waitForConnections: true, connectionLimit: 10, multipleStatements: true };
}
function getMysqlPool() {
  pool ??= mysql.createPool(config());
  return pool;
}

// src/scripts/migrate-mysql.ts
async function main() {
  const pool2 = getMysqlPool();
  try {
    await pool2.query("SELECT 1");
    await pool2.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) NOT NULL PRIMARY KEY,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../migrations/mysql");
    const files = (await fs.readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const name of files) {
      const [existing] = await pool2.query("SELECT name FROM schema_migrations WHERE name = ? LIMIT 1", [name]);
      if (Array.isArray(existing) && existing.length > 0) continue;
      const sql = await fs.readFile(path.join(directory, name), "utf8");
      await pool2.query(sql);
      await pool2.query("INSERT INTO schema_migrations (name) VALUES (?)", [name]);
    }
  } finally {
    await pool2.end();
  }
}
main().catch((err) => {
  process.stderr.write(`MySQL migration failed: ${err instanceof Error ? err.message : "unknown error"}
`);
  process.exitCode = 1;
});
//# sourceMappingURL=migrate-mysql.mjs.map
