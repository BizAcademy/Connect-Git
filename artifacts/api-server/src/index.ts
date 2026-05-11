// Capture toute erreur non gérée AVANT le moindre import (utile pour
// diagnostiquer les crashs au démarrage sur Plesk Passenger : sans ça,
// Passenger affiche juste "We're sorry, but something went wrong" sans
// nous dire pourquoi).
process.on("uncaughtException", (err) => {
  // eslint-disable-next-line no-console
  console.error("[FATAL] uncaughtException:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("[FATAL] unhandledRejection:", reason);
  process.exit(1);
});

import app from "./app";
import { logger } from "./lib/logger";
import { startSupportCleanup } from "./lib/support";
import { purgeSensitiveSettingRows } from "./lib/settings-cleanup";
import { startOrderStatusPoller } from "./lib/order-status-poller";
import { startMissedRefundScanner } from "./lib/missed-refund-scanner";
import { startPendingPaymentScanner } from "./lib/pending-payment-scanner";
import { syncOrderInternal, warmServicesCache } from "./routes/smm";

// PORT detection :
// - Replit/dev : PORT est toujours fourni par l'env -> on l'utilise.
// - Plesk Passenger : PORT n'est pas toujours fourni comme variable
//   classique. Passenger gère le routage via socket et accepte qu'on
//   passe 0 (le système alloue un port libre, Passenger l'intercepte).
// - VPS classique (PM2) : on prend la valeur fournie ou 8080 par défaut.
const rawPort = process.env["PORT"];
let port: number;
if (rawPort && rawPort.trim() !== "") {
  const parsed = Number(rawPort);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }
  port = parsed;
} else if (process.env["NODE_ENV"] === "production") {
  // Production sans PORT explicite (typique Passenger) -> port 0 (auto).
  port = 0;
} else {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startSupportCleanup();
  void purgeSensitiveSettingRows();
  // Pre-warm the enriched services cache so the first user request is instant
  void warmServicesCache();
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
