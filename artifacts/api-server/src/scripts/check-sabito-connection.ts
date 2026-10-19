import { logger } from "../lib/logger";

// Connectivity/authentication only. No member identity and no requested
// operation: this is NOT a successful business verification.
try {
  const url = new URL(process.env.SABITO_URL ?? "");
  const id = process.env.SABITO_CLIENT_ID;
  const secret = process.env.SABITO_CLIENT_SECRET;
  if (
    url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password ||
    url.search || url.hash || !id || !secret
  ) throw new Error("CONFIGURATION");
  const response = await fetch(new URL("/v1/backend/jobs/poll", url), {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`, "utf8").toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ operations: [] }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    logger.warn({ http: response.status, code: "POLL_REJECTED" }, "Sabito connectivity check");
    await response.body?.cancel();
    process.exitCode = 1;
  } else {
    const body = await response.json() as { jobs?: unknown[] };
    const valid = Array.isArray(body.jobs) && body.jobs.length === 0;
    logger.info({ http: response.status, code: valid ? "HTTPS_AUTH_OK_NO_OPERATIONS" : "UNEXPECTED_POLL_RESPONSE" }, "Sabito connectivity check");
    if (!valid) process.exitCode = 1;
  }
} catch {
  logger.warn({ code: "CONFIGURATION_NETWORK_OR_TLS_FAILURE" }, "Sabito connectivity check");
  process.exitCode = 1;
}
