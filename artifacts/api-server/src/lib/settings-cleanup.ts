import { logger } from "./logger";

const SUPABASE_URL = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];

// Legacy keys from previous payment integrations that may still exist in
// historical databases. Purged on every server boot so they cannot leak
// from the `settings` table (which is now meant for non-secret data only).
const SENSITIVE_SETTING_KEYS = [
  "soleaspay_api_key",
  "soleaspay_merchant_id",
  "soleaspay_callback_url",
];

export async function purgeSensitiveSettingRows(): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    logger.warn(
      "SUPABASE_SERVICE_ROLE_KEY not set — cannot purge sensitive setting rows. " +
      "Apply the SQL migration in migrations/001_settings_rls.sql manually.",
    );
    return;
  }

  try {
    const keysFilter = SENSITIVE_SETTING_KEYS.map(k => `key.eq.${k}`).join(",");
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/settings?or=(${encodeURIComponent(keysFilter)})`,
      {
        method: "DELETE",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: "return=minimal",
        },
      },
    );
    if (r.ok) {
      logger.info({ keys: SENSITIVE_SETTING_KEYS }, "sensitive settings rows purged");
    } else {
      const body = await r.text();
      logger.error({ status: r.status, body }, "failed to purge sensitive settings rows");
    }
  } catch (err) {
    logger.error({ err }, "error during sensitive settings row purge");
  }
}
