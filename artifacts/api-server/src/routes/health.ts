import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

// Build timestamp injected at build time (falls back to "dev" in development)
const BUILD_TIME = process.env.BUILD_TIME ?? "dev";

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Diagnostic endpoint — shows config presence without exposing secret values.
// Usage: GET /api/diag
// In production: curl https://yourdomain.com/api/diag
router.get("/diag", (_req, res) => {
  const env = process.env;
  res.json({
    build_time: BUILD_TIME,
    node_env: env.NODE_ENV ?? "unset",
    supabase_url: env.VITE_SUPABASE_URL ? env.VITE_SUPABASE_URL : "MISSING",
    supabase_anon_key: env.VITE_SUPABASE_ANON_KEY ? "✓ present" : "MISSING",
    supabase_service_role_key: env.SUPABASE_SERVICE_ROLE_KEY ? "✓ present" : "MISSING — fallback JWT actif",
    afribapay_api_user: env.AFRIBAPAY_API_USER ? "✓ present" : "MISSING",
    afribapay_api_key: env.AFRIBAPAY_API_KEY ? "✓ present" : "MISSING",
    afribapay_merchant_key: env.AFRIBAPAY_MERCHANT_KEY ? "✓ present" : "MISSING",
    session_secret: env.SESSION_SECRET ? "✓ present" : "MISSING",
    port: env.PORT ?? "unset",
  });
});

export default router;
