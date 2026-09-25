import { randomUUID } from "node:crypto";

const ENDPOINT = "https://api.bizconnectacademy.com/api/v2/external/notifications/email";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface BizConnectEmailNotification {
  recipient_email: string;
  subject: string;
  title: string;
  message: string;
  details?: Record<string, string>;
  action_url?: string;
  action_label?: string;
}

export interface BizConnectDelivery {
  deliveryId: string;
  status: string;
  duplicate: boolean;
  idempotencyKey: string;
}

export interface BizConnectNotificationConfig {
  clientId: string;
  clientSecret: string;
}

/** Returns null when unused; rejects partial or explicitly enabled configurations. */
export function validateBizConnectNotificationConfig(
  env: NodeJS.ProcessEnv = process.env,
): BizConnectNotificationConfig | null {
  const clientId = env["BIZCONNECT_CLIENT_ID"]?.trim();
  const clientSecret = env["BIZCONNECT_CLIENT_SECRET"]?.trim();
  const enabled = env["BIZCONNECT_NOTIFICATIONS_ENABLED"] === "true";
  if (!clientId && !clientSecret && !enabled) return null;
  if (!clientId || !clientSecret) {
    throw new Error("BizConnect notifications: BIZCONNECT_CLIENT_ID and BIZCONNECT_CLIENT_SECRET are required");
  }
  return { clientId, clientSecret };
}

export class BizConnectNotificationError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null,
    public readonly code: string | null = null,
  ) {
    super(message);
    this.name = "BizConnectNotificationError";
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeErrorCode(payload: unknown): string | null {
  const body = object(payload);
  const nested = object(body?.["error"]);
  const code = body?.["code"] ?? body?.["error_code"] ?? nested?.["code"];
  // Never expose an arbitrary provider error message: it could echo the OTP,
  // recipient, Client Secret, or the notification's content.
  return typeof code === "string" && /^[A-Z][A-Z_]{0,63}$/.test(code) ? code : null;
}

function validateNotification(input: BizConnectEmailNotification): void {
  let actionUrlValid = true;
  if (input?.action_url !== undefined) {
    try { actionUrlValid = new URL(input.action_url).protocol === "https:"; }
    catch { actionUrlValid = false; }
  }
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      typeof input.recipient_email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.recipient_email) ||
      ![input.subject, input.title, input.message].every(value => typeof value === "string" && value.trim().length > 0) ||
      (input.details !== undefined && (!object(input.details) ||
        !Object.entries(input.details).every(([key, value]) => key.length > 0 && typeof value === "string"))) ||
      (input.action_label !== undefined && typeof input.action_label !== "string") ||
      (input.action_url !== undefined && typeof input.action_url !== "string") ||
      !actionUrlValid) {
    throw new TypeError("Invalid BizConnect email notification");
  }
}

/**
 * Reuse one instance across calls. Supply the same explicit idempotencyKey
 * when retrying a logical notification; automatically generated keys are unique
 * per call and cannot deduplicate retries across process restarts.
 */
export class BizConnectNotificationClient {
  private readonly config: BizConnectNotificationConfig;
  private readonly http: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: {
    config?: BizConnectNotificationConfig;
    http?: typeof fetch;
    timeoutMs?: number;
  } = {}) {
    const config = options.config ?? validateBizConnectNotificationConfig();
    if (!config?.clientId?.trim() || !config.clientSecret?.trim()) {
      throw new Error("BizConnect notifications are not configured");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("Invalid notification timeout");
    this.config = config;
    this.http = options.http ?? fetch;
    this.timeoutMs = timeoutMs;
  }

  async sendEmail(input: BizConnectEmailNotification, idempotencyKey = randomUUID()): Promise<BizConnectDelivery> {
    validateNotification(input);
    if (typeof idempotencyKey !== "string" || !/^[\x21-\x7E]{1,255}$/.test(idempotencyKey)) {
      throw new TypeError("Invalid Idempotency-Key");
    }

    // Only send fields in the public contract; don't forward unknown runtime
    // properties that a caller accidentally attached to the object.
    const body: BizConnectEmailNotification = {
      recipient_email: input.recipient_email,
      subject: input.subject,
      title: input.title,
      message: input.message,
      ...(input.details !== undefined ? { details: input.details } : {}),
      ...(input.action_url !== undefined ? { action_url: input.action_url } : {}),
      ...(input.action_label !== undefined ? { action_label: input.action_label } : {}),
    };
    let response: Response;
    try {
      response = await this.http(ENDPOINT, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "X-BCA-Client-ID": this.config.clientId,
          "X-BCA-Client-Secret": this.config.clientSecret,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Fetch errors can include URLs or request data. Never include the
      // original exception in logs or in the public error.
      throw new BizConnectNotificationError("BizConnect notification request failed or timed out", null);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (response.ok) throw new BizConnectNotificationError("Invalid BizConnect notification response", response.status);
      throw new BizConnectNotificationError(`BizConnect notification failed (HTTP ${response.status})`, response.status);
    }
    if (!response.ok) {
      throw new BizConnectNotificationError(
        `BizConnect notification failed (HTTP ${response.status})`,
        response.status,
        safeErrorCode(payload),
      );
    }

    const data = object(payload);
    const result = object(data?.["data"]) ?? data;
    const deliveryId = result?.["delivery_id"];
    const status = result?.["status"];
    const duplicate = result?.["duplicate"];
    if (typeof deliveryId !== "string" || !deliveryId.trim() ||
        typeof status !== "string" || !status.trim() || typeof duplicate !== "boolean") {
      throw new BizConnectNotificationError("Invalid BizConnect notification response", response.status);
    }
    return { deliveryId, status, duplicate, idempotencyKey };
  }
}