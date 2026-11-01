import { getMysqlPool } from "./mysql";

type Check = { stage: string; code: string; http?: number };
const environmentKeys = [
  "SABITO_URL", "SABITO_CLIENT_ID", "SABITO_CLIENT_SECRET",
  "MYSQL_HOST", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_PORT",
] as const;
/** Fixed names and booleans only. Never serialize process.env or its values. */
export function inspectSabitoEnvironment(env: Record<string, string | undefined> = process.env) {
  return environmentKeys.map(key => ({
    key, present: typeof env[key] === "string" && (key === "MYSQL_PASSWORD" || !!env[key]?.trim()),
  }));
}
const safeCodes = new Set([
  "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET",
  "ER_ACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR", "ER_BAD_FIELD_ERROR", "ER_NO_SUCH_TABLE",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
export function diagnosticCode(error: unknown, fallback: string): string {
  let candidate = error;
  for (let depth = 0; depth < 3 && candidate && typeof candidate === "object"; depth++) {
    const record = candidate as { code?: unknown; cause?: unknown; name?: unknown };
    if (safeCodes.has(String(record.code))) return String(record.code);
    if (record.name === "TimeoutError" || record.name === "AbortError") return "ETIMEDOUT";
    candidate = record.cause;
  }
  return fallback;
}

const schemaChecks = {
  users: "SELECT id, disabled_at, email_verified_at FROM users LIMIT 0",
  profiles: "SELECT user_id, balance_minor, balance_usd_minor, referral_code FROM profiles LIMIT 0",
  payments: `SELECT user_id, method, provider, operator, country, phone_number, transaction_id,
    order_id, reference, provider_reference, credited_at, amount_minor, currency,
    bonus_amount_minor, bonus_status, bonus_credited_at, wallet_credited FROM payments LIMIT 0`,
  orders: `SELECT user_id, provider_order_id, external_order_id, status, quantity,
    charge_minor, currency, refunded_at, refunded_amount_minor FROM orders LIMIT 0`,
  movements: "SELECT user_id, type, amount_minor, currency, reference_id, reference_type, created_at FROM wallet_transactions LIMIT 0",
  referrals: `SELECT referrer_user_id, referred_user_id, status, referrer_bonus_minor,
    referred_bonus_minor, referrer_credited_at, referred_credited_at FROM referrals LIMIT 0`,
  tickets: "SELECT user_id, order_local_id, order_external_id, provider_id, status FROM tickets LIMIT 0",
};

/** Never requests a job, reads a member row, exposes a response body or writes. */
export async function runSabitoDiagnostics(options: {
  env?: Record<string, string | undefined>;
  request?: typeof fetch;
  read?: (sql: string) => Promise<unknown>;
  nodeMajor?: number;
} = {}): Promise<{ ok: boolean; checks: Check[] }> {
  const env = options.env ?? process.env;
  const request = options.request ?? fetch;
  const read = options.read ?? (async sql => {
    await getMysqlPool().query({ sql, timeout: 5000 });
  });
  const checks: Check[] = [];
  let ok = true;
  const nodeMajor = options.nodeMajor ?? Number(process.versions.node.split(".")[0]);
  checks.push({ stage: "runtime", code: nodeMajor >= 21 ? "NODE_SUPPORTED" : "NODE_21_REQUIRED" });
  if (nodeMajor < 21) ok = false;
  let url: URL | undefined;
  try {
    url = new URL(env.SABITO_URL ?? "");
    if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
      throw new Error("INVALID");
    }
    checks.push({ stage: "configuration", code: "SABITO_HTTPS_ORIGIN_VALID" });
  } catch {
    url = undefined; ok = false;
    checks.push({ stage: "configuration", code: "SABITO_URL_INVALID" });
  }
  const credentials = !!env.SABITO_CLIENT_ID && !!env.SABITO_CLIENT_SECRET;
  if (!credentials) {
    ok = false;
    checks.push({ stage: "configuration", code: "SABITO_CREDENTIALS_MISSING" });
  }
  if (url && credentials) {
    try {
      const response = await request(new URL("/v1/backend/jobs/poll", url), {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${env.SABITO_CLIENT_ID}:${env.SABITO_CLIENT_SECRET}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ operations: [] }),
        signal: AbortSignal.timeout(10_000), redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel(); ok = false;
        checks.push({ stage: "https_auth", http: response.status, code: "POLL_REJECTED" });
      } else {
        const body = await response.json() as { jobs?: unknown };
        const valid = Array.isArray(body.jobs) && body.jobs.length === 0;
        checks.push({ stage: "https_auth", http: response.status,
          code: valid ? "HTTPS_AUTH_OK_NO_OPERATIONS" : "UNEXPECTED_POLL_RESPONSE" });
        if (!valid) ok = false;
      }
    } catch (error) {
      ok = false;
      checks.push({ stage: "https_auth", code: diagnosticCode(error, "NETWORK_OR_TLS_FAILURE") });
    }
  }
  try {
    await read("SELECT 1");
    checks.push({ stage: "database", code: "DATABASE_REACHABLE" });
    for (const [name, sql] of Object.entries(schemaChecks)) {
      try {
        await read(sql);
        checks.push({ stage: `schema_${name}`, code: "SCHEMA_READABLE" });
      } catch (error) {
        ok = false;
        checks.push({ stage: `schema_${name}`, code: diagnosticCode(error, "SCHEMA_UNAVAILABLE") });
      }
    }
  } catch (error) {
    ok = false;
    checks.push({ stage: "database", code: diagnosticCode(error, "DATABASE_UNAVAILABLE") });
  }
  return { ok, checks };
}
