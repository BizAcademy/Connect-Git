import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getMysqlPool } from "../lib/mysql";

const router: IRouter = Router();

// Build timestamp injected at build time (falls back to "dev" in development)
const BUILD_TIME = process.env.BUILD_TIME ?? "dev";

router.get("/healthz", async (_req, res) => {
  try {
    await getMysqlPool().query("SELECT 1");
    res.json(HealthCheckResponse.parse({ status: "ok" }));
  } catch {
    res.status(503).json({ status: "error", database: "unavailable" });
  }
});

// Diagnostic endpoint — shows config presence without exposing secret values.
// Usage: GET /api/diag
// In production: curl https://yourdomain.com/api/diag
router.get("/diag", (_req, res) => {
  const env = process.env;
  res.json({
    build_time: BUILD_TIME,
    node_env: env.NODE_ENV ?? "unset",
    mysql_configured: Boolean(env.MYSQL_HOST && env.MYSQL_DATABASE && env.MYSQL_USER && env.MYSQL_PASSWORD !== undefined),
    afribapay_api_user: env.AFRIBAPAY_API_USER ? "✓ present" : "MISSING",
    afribapay_api_key: env.AFRIBAPAY_API_KEY ? "✓ present" : "MISSING",
    afribapay_merchant_key: env.AFRIBAPAY_MERCHANT_KEY ? "✓ present" : "MISSING",
    session_secret: env.SESSION_SECRET ? "✓ present" : "MISSING",
    port: env.PORT ?? "unset",
  });
});

export default router;
