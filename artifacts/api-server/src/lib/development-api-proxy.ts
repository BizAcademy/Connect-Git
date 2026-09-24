import https from "node:https";
import type { RequestHandler } from "express";
import { logger } from "./logger";

const upstreamValue = process.env["NODE_ENV"] !== "production"
  ? process.env["DEV_PLESK_API_ORIGIN"]
  : undefined;

let upstream: URL | undefined;
if (upstreamValue) {
  upstream = new URL(upstreamValue);
  if (upstream.protocol !== "https:" || upstream.pathname !== "/" || upstream.search || upstream.hash || upstream.username || upstream.password) {
    throw new Error("DEV_PLESK_API_ORIGIN must be an HTTPS origin without credentials or a path");
  }
}

export const livePreviewProxyEnabled = Boolean(upstream);

const hopByHop = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

export const developmentApiProxy: RequestHandler = (req, res) => {
  if (!upstream) {
    res.status(503).json({ error: "API Plesk non configurée" });
    return;
  }

  const headers = { ...req.headers };
  for (const name of hopByHop) delete headers[name];
  delete headers.host;

  const target = upstream;
  const remote = https.request({
    hostname: target.hostname,
    port: target.port || 443,
    method: req.method,
    path: req.originalUrl,
    headers: { ...headers, host: target.host },
    timeout: 20_000,
  }, response => {
    res.status(response.statusCode ?? 502);
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined || hopByHop.has(name)) continue;
      if (name === "set-cookie") {
        // A production cookie must belong to the preview origin in this mode.
        const cookies = Array.isArray(value) ? value : [value];
        res.setHeader(name, cookies.map(cookie => cookie.replace(/;\s*Domain=[^;]*/gi, "")));
      } else {
        res.setHeader(name, value);
      }
    }
    response.pipe(res);
  });

  remote.on("timeout", () => remote.destroy(new Error("Plesk API timed out")));
  remote.on("error", err => {
    logger.error({ err, path: req.path }, "development Plesk API proxy failed");
    if (!res.headersSent) res.status(502).json({ error: "API Plesk indisponible" });
    else res.destroy(err);
  });
  req.on("aborted", () => remote.destroy());
  req.pipe(remote);
};