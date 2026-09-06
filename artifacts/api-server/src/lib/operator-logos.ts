/**
 * Operator logo management — stores custom logo URLs in the `settings` table
 * under keys prefixed with `operator_logo_`.
 *
 * 30-second in-memory cache so admin changes are visible to users
 * within half a minute without repeatedly querying MySQL.
 */
import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { RowDataPacket } from "mysql2/promise";
import { logger } from "./logger";
import { getMysqlPool } from "./mysql";

const KEY_PREFIX = "operator_logo_";
const CACHE_TTL_MS = 30_000;
const LOGO_DIR = path.resolve(process.cwd(), "data", "operator-logos");
const LOGO_URL_PREFIX = "/api/payments/operator-logos/file/";

interface LogosCache {
  value: Record<string, string>;
  expiresAt: number;
}
let cache: LogosCache | null = null;

export function bustOperatorLogosCache(): void {
  cache = null;
}

/** Returns a map of operatorCode → logo URL for all configured operators. */
export async function fetchOperatorLogos(): Promise<Record<string, string>> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  try {
    const [rows] = await getMysqlPool().execute<RowDataPacket[]>(
      "SELECT `key`, `value` FROM settings WHERE `key` LIKE ?",
      [`${KEY_PREFIX}%`],
    );
    const logos: Record<string, string> = {};
    for (const row of rows) {
      const code = row.key.slice(KEY_PREFIX.length);
      if (code && row.value) logos[code] = row.value;
    }
    cache = { value: logos, expiresAt: Date.now() + CACHE_TTL_MS };
    return logos;
  } catch (err) {
    logger.warn({ err }, "fetchOperatorLogos failed");
    return {};
  }
}

/** Save a logo URL for a given operator code. */
export async function upsertOperatorLogo(operatorCode: string, logoUrl: string): Promise<void> {
  const key = KEY_PREFIX + operatorCode;
  await getMysqlPool().execute(
    "INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
    [key, logoUrl],
  );
  bustOperatorLogosCache();
}

/**
 * Upload an image buffer to local application storage and store its API URL.
 * Returns the public URL of the uploaded image.
 */
export async function uploadOperatorLogoFile(
  operatorCode: string,
  fileBuffer: Buffer,
  mimeType: string,
): Promise<string> {
  const ext = mimeType.includes("svg")
    ? "svg"
    : mimeType.includes("png")
      ? "png"
      : "jpg";
  const safeCode = operatorCode.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!safeCode) throw new Error("Invalid operator code");
  const filename = `${safeCode}-${crypto.randomBytes(8).toString("hex")}.${ext}`;
  await fs.mkdir(LOGO_DIR, { recursive: true });
  await fs.writeFile(path.join(LOGO_DIR, filename), fileBuffer, { flag: "wx" });
  const publicUrl = `${LOGO_URL_PREFIX}${encodeURIComponent(filename)}?t=${Date.now()}`;
  await upsertOperatorLogo(operatorCode, publicUrl);
  return publicUrl;
}

/** Delete the custom logo for a given operator code (reverts to default). */
export async function deleteOperatorLogo(operatorCode: string): Promise<void> {
  const key = KEY_PREFIX + operatorCode;
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>(
    "SELECT `value` FROM settings WHERE `key` = ?",
    [key],
  );
  await getMysqlPool().execute("DELETE FROM settings WHERE `key` = ?", [key]);
  const stored = String(rows[0]?.value || "");
  if (stored.startsWith(LOGO_URL_PREFIX)) {
    const filename = stored.slice(LOGO_URL_PREFIX.length).split("?")[0] || "";
    if (/^[a-zA-Z0-9_-]{1,100}-[a-f0-9]{16}\.(svg|png|jpg)$/i.test(filename)) {
      await fs.unlink(path.join(LOGO_DIR, filename)).catch(() => undefined);
    }
  }
  bustOperatorLogosCache();
}

export function operatorLogoPath(filename: string): string | null {
  return /^[a-zA-Z0-9_-]{1,100}-[a-f0-9]{16}\.(svg|png|jpg)$/i.test(filename)
    ? path.join(LOGO_DIR, filename)
    : null;
}
