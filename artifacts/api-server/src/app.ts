import express, { type Express, type Request } from "express";
import cors from "cors";
import compression from "compression";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(compression());
app.use(cors());

// Capture the raw JSON body so webhook handlers (AfribaPay) can verify the
// HMAC-SHA256 signature against the exact bytes received. The verifier writes
// the raw string to `req.rawBody` only for the webhook path to keep memory
// footprint minimal everywhere else.
function captureRawBody(req: Request, _res: unknown, buf: Buffer) {
  if (req.url && req.url.startsWith("/api/payments/webhook")) {
    (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
  }
}

// Allow up to 8 MB JSON payloads to accommodate base64-encoded support images (≤5 MB raw)
app.use(express.json({ limit: "8mb", verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));

app.use("/api", router);

export default app;
