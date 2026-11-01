import { fork, type ChildProcess } from "node:child_process";
import { logger } from "./logger";
import { SABITO_OPERATIONS } from "./sabito-operations";

let running = false;
type ConnectorState = "not_started" | "starting" | "ready" | "polling" | "waiting" | "backoff" | "stopped" | "error";
const snapshot: {
  started: boolean; state: ConnectorState; lastPollHttp: number | null;
  lastPollAt: string | null; lastErrorCode: string | null;
} = { started: false, state: "not_started", lastPollHttp: null, lastPollAt: null, lastErrorCode: null };
export function getSabitoConnectorState() {
  return { ...snapshot };
}
const EVENTS = new Set(["ready", "poll", "delivery", "verification", "database", "waiting", "sdk", "fatal"]);
const OPS = new Set<string>(SABITO_OPERATIONS);
const STATUSES = new Set(["pending", "confirmed", "failed", "ok", "forbidden", "not_found", "error"]);

/** One child per API process; the DB named lock elects one connector globally. */
export function startSabitoSupervisor(workerFile: string) {
  if (running) return;
  running = true;
  snapshot.started = true;
  let child: ChildProcess | undefined;
  let retry: NodeJS.Timeout | undefined;
  let stopped = false;
  let failures = 0;
  function launch() {
    if (stopped) return;
    snapshot.state = "starting";
    child = fork(workerFile, [], {
      execArgv: [],
      // No raw SDK stack, inherited command output or credential-bearing
      // exception can reach the parent logs. Only allowlisted IPC fields.
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let ended = false;
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const m = message as Record<string, unknown>;
      if (m.type !== "sabito" || !EVENTS.has(String(m.event))) return;
      const safe: Record<string, unknown> = { event: m.event };
      if (typeof m.http === "number" && Number.isInteger(m.http) && m.http >= 0 && m.http <= 599) safe.http = m.http;
      if (OPS.has(String(m.operation))) safe.operation = m.operation;
      if (STATUSES.has(String(m.status))) safe.status = m.status;
      if (typeof m.code === "string" && /^[A-Z0-9_]{1,48}$/.test(m.code)) safe.code = m.code;
      if (m.event === "ready") snapshot.state = "ready";
      if (m.event === "waiting") snapshot.state = "waiting";
      if (m.event === "fatal" || m.event === "database") snapshot.state = "error";
      if (m.event === "poll") {
        snapshot.lastPollHttp = typeof safe.http === "number" ? safe.http : null;
        snapshot.lastPollAt = new Date().toISOString();
        snapshot.state = m.http === 200 ? "polling" : "error";
      }
      if (snapshot.state === "error" && typeof safe.code === "string") snapshot.lastErrorCode = safe.code;
      if (m.event === "poll" && m.http === 200) failures = 0;
      logger.info(safe, "Sabito connector");
    });
    const restart = () => {
      if (ended) return;
      ended = true;
      child = undefined;
      if (stopped) return;
      snapshot.state = "backoff";
      const delayMs = Math.min(60_000, 2000 * 2 ** Math.min(failures++, 5));
      logger.warn({ code: "CHILD_RESTART", delayMs }, "Sabito connector");
      retry = setTimeout(launch, delayMs);
    };
    child.once("error", () => {
      snapshot.lastErrorCode = "CHILD_START_FAILED";
      logger.warn({ code: "CHILD_START_FAILED" }, "Sabito connector");
      restart();
    });
    child.once("exit", restart);
  }
  const stop = () => {
    stopped = true;
    snapshot.state = "stopped";
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
