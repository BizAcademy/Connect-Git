import type { RowDataPacket } from "mysql2/promise";
import { getMysqlPool } from "./mysql";

const KEY = "sabito_widget_settings";

export async function isSabitoEnabled(): Promise<boolean> {
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>(
    "SELECT `value` FROM settings WHERE `key`=? LIMIT 1", [KEY],
  );
  // Preserve the existing enabled state until an administrator changes it.
  if (!rows[0]) return true;
  const saved: unknown = JSON.parse(String(rows[0].value));
  if (!saved || typeof saved !== "object" || typeof (saved as { enabled?: unknown }).enabled !== "boolean") {
    throw new Error("Invalid Sabito visibility setting");
  }
  return (saved as { enabled: boolean }).enabled;
}

export async function saveSabitoEnabled(enabled: boolean, adminId: string): Promise<void> {
  await getMysqlPool().execute(
    "INSERT INTO settings (`key`,`value`,updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`),updated_by=VALUES(updated_by)",
    [KEY, JSON.stringify({ enabled }), adminId],
  );
}
