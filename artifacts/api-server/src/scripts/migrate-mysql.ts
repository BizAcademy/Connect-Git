import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMysqlPool } from "../lib/mysql";

async function main() {
  const args = process.argv.slice(2);
  const fromArg = args.find((arg) => /^--from=\d{3}$/.test(arg));
  const toArg = args.find((arg) => /^--to=\d{3}$/.test(arg));
  if (args.length > 0 && (args.length !== 2 || !fromArg || !toArg ||
      Number(fromArg.slice(7)) > Number(toArg.slice(5)))) {
    throw new Error("Usage: migrate-mysql [--from=008 --to=011]");
  }
  const from = fromArg ? Number(fromArg.slice(7)) : null;
  const to = toArg ? Number(toArg.slice(5)) : null;
  const pool = getMysqlPool();
  try {
    await pool.query("SELECT 1");
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) NOT NULL PRIMARY KEY,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );
    const candidates = [
      path.resolve(process.cwd(), "migrations/mysql"),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../migrations/mysql"),
    ];
    let directory: string | null = null;
    for (const candidate of candidates) {
      try { await fs.access(candidate); directory = candidate; break; } catch {}
    }
    if (!directory) throw new Error("Dossier migrations/mysql introuvable");
    const files = (await fs.readdir(directory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .filter((name) => from === null || (Number.parseInt(name, 10) >= from && Number.parseInt(name, 10) <= to!))
      .sort();
    let applied = 0;
    for (const name of files) {
      const [existing] = await pool.query("SELECT name FROM schema_migrations WHERE name = ? LIMIT 1", [name]);
      if (Array.isArray(existing) && existing.length > 0) continue;
      const sql = await fs.readFile(path.join(directory, name), "utf8");
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (name) VALUES (?)", [name]);
      applied++;
      process.stdout.write(`Applied MySQL migration: ${name}\n`);
    }
    process.stdout.write(`MySQL migrations complete (${applied} applied)\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(`MySQL migration failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
  process.exitCode = 1;
});