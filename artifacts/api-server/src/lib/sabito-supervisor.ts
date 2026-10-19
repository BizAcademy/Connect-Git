import { fork, type ChildProcess } from "node:child_process";
import { logger } from "./logger";

let running = false;
const EVENTS = new Set(["ready", "poll", "delivery", "verification", "database", "waiting", "sdk", "fatal"]);
const OPS = new Set(["account_activation", "deposit_status", "referral_code"]);
const STATUSES = new Set(["active", "inactive", "pending", "confirmed", "failed", "ok", "forbidden", "not_found", "error"]);

/** One child per API process; the DB named lock elects one connector globally. */
export function startSabitoSupervisor(workerFile: string) {
  if (running) return;
  running = true;
  let child: ChildProcess | undefined;
  let retry: NodeJS.Timeout | undefined;
  let stopped = false;
  let failures = 0;
  function launch() {
    if (stopped) return;
    child = fork(workerFile, [], {
      execArgv: [],
      // No raw SDK stack, inherited command output or credential-bearing
      // exception can reach the parent logs. Only allowlisted IPC fields.
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const m = message as Record<string, unknown>;
      if (m.type !== "sabito" || !EVENTS.has(String(m.event))) return;
      const safe: Record<string, unknown> = { event: m.event };
      if (typeof m.http === "number" && Number.isInteger(m.http) && m.http >= 0 && m.http <= 599) safe.http = m.http;
      if (OPS.has(String(m.operation))) safe.operation = m.operation;
      if (STATUSES.has(String(m.status))) safe.status = m.status;
      if (typeof m.code === "string" && /^[A-Z0-9_]{1,48}$/.test(m.code)) safe.code = m.code;
      if (m.event === "poll" && m.http === 200) failures = 0;
      logger.info(safe, "Sabito connector");
    });
    child.once("error", () => logger.warn({ code: "CHILD_START_FAILED" }, "Sabito connector"));
    child.once("exit", () => {
      child = undefined;
      if (stopped) return;
      const delayMs = Math.min(60_000, 2000 * 2 ** Math.min(failures++, 5));
      logger.warn({ code: "CHILD_RESTART", delayMs }, "Sabito connector");
      retry = setTimeout(launch, delayMs);
    });
  }
  const stop = () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    child?.kill("SIGTERM");
  };
  const shutdown = () => {
    stop();
    if (!child) process.exit(0);
    child.once("exit", () => process.exit(0));
    setTimeout(() => { child?.kill("SIGKILL"); process.exit(0); }, 6000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("exit", stop);
  launch();
}
