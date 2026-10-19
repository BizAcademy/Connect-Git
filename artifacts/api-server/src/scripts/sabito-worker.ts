import { startSabitoBackend } from "../vendor/sabito-backend.mjs";
import { createSabitoHandlers } from "../lib/sabito-handlers";
import { getMysqlPool, closeMysqlPool } from "../lib/mysql";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { setTimeout as delay } from "node:timers/promises";

const controller = new AbortController();
const notify = (message: Record<string, unknown>) => {
  if (process.connected) process.send?.({ type: "sabito", ...message });
};
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
process.once("disconnect", () => controller.abort());
process.on("uncaughtException", () => { notify({ event: "fatal", code: "UNCAUGHT" }); process.exit(1); });
process.on("unhandledRejection", () => { notify({ event: "fatal", code: "REJECTION" }); process.exit(1); });

let lock: PoolConnection | undefined;
let heartbeat: NodeJS.Timeout | undefined;
const LOCK = "buzzbooster:sabito:connector";
let phase: "configuration" | "database" | "sdk" = "configuration";
try {
  const url = new URL(process.env.SABITO_URL ?? "");
  if (
    url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password ||
    url.search || url.hash || !process.env.SABITO_CLIENT_ID || !process.env.SABITO_CLIENT_SECRET
  ) throw new Error("CONFIGURATION");

  // Never claim jobs while the business database is unreachable.
  phase = "database";
  lock = await getMysqlPool().getConnection();
  let waitingLogged = false;
  while (!controller.signal.aborted) {
    const [rows] = await lock.execute<RowDataPacket[]>(
      { sql: "SELECT GET_LOCK(?, 0) AS acquired", timeout: 5000 }, [LOCK],
    );
    if (Number(rows[0]?.acquired) === 1) break;
    if (!waitingLogged) notify({ event: "waiting", code: "ANOTHER_CONNECTOR_ACTIVE" });
    waitingLogged = true;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, 5000);
      controller.signal.addEventListener("abort", done, { once: true });
    });
  }
  if (!controller.signal.aborted) {
    phase = "sdk";
    lock.on("error", () => controller.abort());
    heartbeat = setInterval(() => {
      void lock?.execute({ sql: "SELECT 1", timeout: 5000 }).catch(() => controller.abort());
    }, 30_000);
    const originalFetch = globalThis.fetch;
    let lastPoll = 0;
    let lastHttp = -1;
    globalThis.fetch = async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      try {
        const response = await originalFetch(input, init);
        if (target.origin === url.origin && target.pathname === "/v1/backend/jobs/poll") {
          if (response.status !== lastHttp || Date.now() - lastPoll >= 30_000) {
            notify({ event: "poll", http: response.status });
            lastPoll = Date.now(); lastHttp = response.status;
          }
          if (!response.ok) {
            await response.body?.cancel();
            // The official SDK retries quickly; do not hammer a provider
            // rejecting credentials or applying a rate limit.
            await delay(response.status === 429 ? 30_000 : 5000, undefined, {
              signal: controller.signal,
            }).catch(() => {});
          }
        } else if (target.origin === url.origin && /^\/v1\/backend\/jobs\/[^/]+\/result$/.test(target.pathname)) {
          notify({ event: "delivery", http: response.status });
        }
        return response;
      } catch {
        if (!controller.signal.aborted && lastHttp !== 0) {
          notify({ event: "poll", http: 0, code: "NETWORK_OR_TLS_FAILURE" }); lastHttp = 0;
        }
        throw new Error("SABITO_TRANSPORT_ERROR");
      }
    };
    const handlers = createSabitoHandlers();
    for (const operation of Object.keys(handlers) as (keyof typeof handlers)[]) {
      const original = handlers[operation];
      handlers[operation] = async job => {
        const result = await original(job);
        notify({ event: "verification", operation, status: result.status });
        return result;
      };
    }
    notify({ event: "ready", code: "DATABASE_READY" });
    let lastSdkError = 0;
    await startSabitoBackend({
      handlers, signal: controller.signal,
      onError: code => {
        if (Date.now() - lastSdkError >= 30_000) {
          notify({ event: "sdk", code }); lastSdkError = Date.now();
        }
      },
    });
    globalThis.fetch = originalFetch;
  }
} catch (error) {
  const databaseCodes = new Set([
    "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ER_ACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR",
  ]);
  const candidate = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const code = phase === "configuration" ? "CONFIGURATION_INVALID" :
    phase === "database" ? (databaseCodes.has(candidate) ? candidate : "DATABASE_UNAVAILABLE") :
    "CONNECTOR_RUNTIME_FAILURE";
  notify({ event: "fatal", code });
  process.exitCode = 1;
} finally {
  controller.abort();
  if (heartbeat) clearInterval(heartbeat);
  if (lock) {
    await lock.execute({ sql: "SELECT RELEASE_LOCK(?)", timeout: 2000 }, [LOCK]).catch(() => {});
    lock.release();
  }
  await closeMysqlPool().catch(() => {});
  // A fork with a disconnect listener keeps its IPC channel referenced.
  // Release it so a failed worker actually exits and can be restarted.
  if (process.connected) process.disconnect?.();
}
