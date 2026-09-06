import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { getMysqlPool } from "./mysql";

export interface EarningRecord {
  ts: string;
  provider_order_id: string;
  user_id: string;
  service: number;
  service_name: string;
  quantity: number;
  rate_usd: number;
  user_price_fcfa: number;
  provider_cost_usd: number;
  provider_cost_fcfa: number;
  gain_fcfa: number;
  provider?: number;
  order_id?: string;
  currency?: string;
}

const COST_FCFA_PER_USD = 600;
const USER_FCFA_PER_USD = 700;

export function computeEarning(input: { user_price_fcfa: number; rate_usd: number; quantity: number }) {
  const provider_cost_usd = (input.quantity / 1000) * Number(input.rate_usd);
  const provider_cost_fcfa = Math.round(provider_cost_usd * COST_FCFA_PER_USD);
  return { provider_cost_usd, provider_cost_fcfa, gain_fcfa: Math.round(input.user_price_fcfa - provider_cost_fcfa) };
}

export function estimateGainFromRevenue(user_price_fcfa: number) {
  const safe = Math.max(0, Math.round(Number(user_price_fcfa) || 0));
  const gain_fcfa = Math.round(safe * (USER_FCFA_PER_USD - COST_FCFA_PER_USD) / USER_FCFA_PER_USD);
  return { provider_cost_fcfa: safe - gain_fcfa, gain_fcfa };
}

function record(row: RowDataPacket): EarningRecord {
  return {
    ts: new Date(row.created_at).toISOString(), provider_order_id: String(row.provider_order_id),
    user_id: String(row.user_id), service: Number(row.service), service_name: String(row.service_name),
    quantity: Number(row.quantity), rate_usd: Number(row.rate_usd),
    user_price_fcfa: Number(row.user_price_minor) / 100, provider_cost_usd: Number(row.provider_cost_usd),
    provider_cost_fcfa: Number(row.provider_cost_minor) / 100, gain_fcfa: Number(row.gain_minor) / 100,
    provider: Number(row.provider),
  };
}

export async function appendEarning(rec: EarningRecord): Promise<void> {
  await getMysqlPool().execute(
    `INSERT INTO earnings (id,user_id,order_id,provider_order_id,service,service_name,quantity,rate_usd,user_price_minor,provider_cost_usd,provider_cost_minor,gain_minor,currency,provider,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE provider_order_id=provider_order_id`,
     [randomUUID(), rec.user_id, rec.order_id ?? null, String(rec.provider_order_id), rec.service, rec.service_name || "", rec.quantity,
       rec.rate_usd, Math.round(rec.user_price_fcfa * 100), rec.provider_cost_usd, Math.round(rec.provider_cost_fcfa * 100),
       Math.round(rec.gain_fcfa * 100), rec.currency ?? "XOF", rec.provider ?? 1, new Date(rec.ts)],
  );
}

export async function findEarningOwner(providerOrderId: string, provider?: number): Promise<string | null> {
  const sql = provider === undefined
    ? "SELECT user_id FROM earnings WHERE provider_order_id=? LIMIT 1"
    : "SELECT user_id FROM earnings WHERE provider_order_id=? AND provider=? LIMIT 1";
  const [rows] = await getMysqlPool().execute<(RowDataPacket & { user_id: string })[]>(sql, provider === undefined ? [providerOrderId] : [providerOrderId, provider]);
  return rows[0]?.user_id ?? null;
}

export async function findEarning(providerOrderId: string, provider?: number): Promise<EarningRecord | null> {
  const sql = provider === undefined
    ? "SELECT * FROM earnings WHERE provider_order_id=? LIMIT 1"
    : "SELECT * FROM earnings WHERE provider_order_id=? AND provider=? LIMIT 1";
  const [rows] = await getMysqlPool().execute<RowDataPacket[]>(sql, provider === undefined ? [providerOrderId] : [providerOrderId, provider]);
  return rows[0] ? record(rows[0]) : null;
}

export async function readEarnings(): Promise<EarningRecord[]> {
  const [rows] = await getMysqlPool().query<RowDataPacket[]>("SELECT * FROM earnings ORDER BY created_at DESC");
  return rows.map(record);
}