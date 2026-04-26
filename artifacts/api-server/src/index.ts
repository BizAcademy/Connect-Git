import app from "./app";
import { logger } from "./lib/logger";
import { startSupportCleanup } from "./lib/support";
import { purgeSensitiveSettingRows } from "./lib/settings-cleanup";
import { startOrderStatusPoller } from "./lib/order-status-poller";
import { startMissedRefundScanner } from "./lib/missed-refund-scanner";
import { startPendingPaymentScanner } from "./lib/pending-payment-scanner";
import { syncOrderInternal } from "./routes/smm";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startSupportCleanup();
  void purgeSensitiveSettingRows();
  // Background poller: pushes provider status updates onto local orders so
  // user/admin views always reflect "Terminée" without depending on someone
  // having the page open. Realtime then propagates the change to any
  // connected client instantly.
  startMissedRefundScanner();
  startPendingPaymentScanner();
  startOrderStatusPoller(async (externalId, providerId) => {
    const r = await syncOrderInternal({ externalId, providerId });
    return r.ok
      ? { ok: true, status: r.status, refunded: r.refunded }
      : { ok: false };
  });
});
