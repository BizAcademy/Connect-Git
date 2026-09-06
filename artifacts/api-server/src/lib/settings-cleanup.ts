import { logger } from "./logger";
import { getMysqlPool } from "./mysql";

const SENSITIVE_SETTING_KEYS = ["soleaspay_api_key", "soleaspay_merchant_id", "soleaspay_callback_url"];

export async function purgeSensitiveSettingRows(): Promise<void> {
  try {
    await getMysqlPool().query("DELETE FROM settings WHERE `key` IN (?)", [SENSITIVE_SETTING_KEYS]);
    logger.info({ keys: SENSITIVE_SETTING_KEYS }, "sensitive settings rows purged");
  } catch (err) {
    logger.error({ err }, "error during sensitive settings row purge");
  }
}