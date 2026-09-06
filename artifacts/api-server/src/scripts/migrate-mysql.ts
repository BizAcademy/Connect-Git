import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMysqlPool } from "../lib/mysql";

async function main() {
  const pool = getMysqlPool();
  try {
    await pool.query("SELECT 1");
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) NOT NULL PRIMARY KEY,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );
    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../migrations/mysql");
    const files = (await fs.readdir(directory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    for (const name of files) {
      const [existing] = await pool.query("SELECT name FROM schema_migrations WHERE name = ? LIMIT 1", [name]);
      if (Array.isArray(existing) && existing.length > 0) continue;
      const sql = await fs.readFile(path.join(directory, name), "utf8");
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (name) VALUES (?)", [name]);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(`MySQL migration failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
  process.exitCode = 1;
});