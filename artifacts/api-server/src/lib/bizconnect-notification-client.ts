const ENDPOINT = "https://api.bizconnectacademy.com/api/v2/external/notifications/email";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface BizConnectEmailNotification {
  recipient_email: string;
  subject: string;
  title: string;
  message: string;
  recipient_name?: string;
  preheader?: string;
  category?: string;
  subtitle?: string;
  details?: Record<string, string>;
  otp_code?: string;
  expires_at?: string;
  action_url?: string;
  action_label?: string;
  note?: string;
}

export interface BizConnectDelivery {
  deliveryId: string | null;
  status: string | null;
  duplicate: boolean;
  idempotencyKey: string;
}

export interface BizConnectNotificationConfig {
  clientId: string;
  clientSecret: string;
  endpoint?: string;
}

/** Returns null when unused; rejects partial or explicitly enabled configurations. */
export function validateBizConnectNotificationConfig(
  env: NodeJS.ProcessEnv = process.env,
): BizConnectNotificationConfig | null {
  const canonical = env["BCA_NOTIFICATION_CLIENT_ID"] !== undefined ||
    env["BCA_NOTIFICATION_CLIENT_SECRET"] !== undefined;
  const clientId = (canonical ? env["BCA_NOTIFICATION_CLIENT_ID"] : env["BIZCONNECT_CLIENT_ID"])?.trim();
  const clientSecret = (canonical ? env["BCA_NOTIFICATION_CLIENT_SECRET"] : env["BIZCONNECT_CLIENT_SECRET"])?.trim();
  const enabled = env["BIZCONNECT_NOTIFICATIONS_ENABLED"] === "true";
  const endpoint = env["BCA_NOTIFICATION_ENDPOINT"]?.trim();
  if (!clientId && !clientSecret && !enabled && endpoint === undefined && !canonical) return null;
  if (!clientId || !clientSecret) {
    throw new Error(`BizConnect notifications: ${canonical ? "BCA_NOTIFICATION_CLIENT_ID and BCA_NOTIFICATION_CLIENT_SECRET" : "BIZCONNECT_CLIENT_ID and BIZCONNECT_CLIENT_SECRET"} are required`);
  }
  if (endpoint !== undefined) validateEndpoint(endpoint);
  return endpoint === undefined ? { clientId, clientSecret } : { clientId, clientSecret, endpoint };
}

export class BizConnectNotificationError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null,
    public readonly code: string | null = null,
    public readonly retryable: boolean = httpStatus === null || httpStatus >= 500,
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

function safeErrorCode(payload: unknown, config: BizConnectNotificationConfig): string | null {
  const body = object(payload);
  const nested = object(body?.["error"]);
  const code = body?.["code"] ?? body?.["error_code"] ?? nested?.["code"];
  // Never expose an arbitrary provider error message: it could echo the OTP,
  // recipient, Client Secret, or the notification's content.
  return typeof code === "string" && /^[A-Z][A-Z_]{0,63}$/.test(code) &&
    !code.includes(config.clientId) && !code.includes(config.clientSecret) ? code : null;
}

function validateEndpoint(endpoint: string): void {
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new TypeError("Invalid BizConnect notification endpoint"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
    throw new TypeError("Invalid BizConnect notification endpoint");
  }
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
      !["recipient_name", "preheader", "category", "subtitle", "otp_code", "expires_at", "action_label", "note"]
        .every(key => input[key as keyof BizConnectEmailNotification] === undefined ||
          typeof input[key as keyof BizConnectEmailNotification] === "string") ||
      (input.action_url !== undefined && typeof input.action_url !== "string") ||
      !actionUrlValid) {
    throw new TypeError("Invalid BizConnect email notification");
  }
}

/**
 * Reuse one instance across calls. The caller must persist the exact body and
 * explicit idempotency key for any later retry; this client never retries.
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
    validateEndpoint(config.endpoint ?? ENDPOINT);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("Invalid notification timeout");
    this.config = config;
    this.http = options.http ?? fetch;
    this.timeoutMs = timeoutMs;
  }

  async sendEmail(input: BizConnectEmailNotification, idempotencyKey: string): Promise<BizConnectDelivery> {
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
      ...(input.recipient_name !== undefined ? { recipient_name: input.recipient_name } : {}),
      ...(input.preheader !== undefined ? { preheader: input.preheader } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.subtitle !== undefined ? { subtitle: input.subtitle } : {}),
      ...(input.details !== undefined ? { details: input.details } : {}),
      ...(input.otp_code !== undefined ? { otp_code: input.otp_code } : {}),
      ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
      ...(input.action_url !== undefined ? { action_url: input.action_url } : {}),
      ...(input.action_label !== undefined ? { action_label: input.action_label } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, this.timeoutMs);
    });
    try {
      // The deadline covers both the headers and the entire response body.
      return await Promise.race([this.request(body, idempotencyKey, controller.signal), timeout]);
    } catch (error) {
      if (error instanceof BizConnectNotificationError) throw error;
      // Never expose original fetch/stream errors, which can contain credentials.
      throw new BizConnectNotificationError("BizConnect notification request failed or timed out", null);
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(body: BizConnectEmailNotification, idempotencyKey: string, signal: AbortSignal): Promise<BizConnectDelivery> {
    const response = await this.http(this.config.endpoint ?? ENDPOINT, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-BCA-Client-ID": this.config.clientId,
        "X-BCA-Client-Secret": this.config.clientSecret,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
      signal,
    });
    let payload: unknown = null;
    let text: string;
    try {
      text = await response.text();
    } catch {
      // A broken response stream is a transport failure, even when the
      // headers already reported 202. The caller may retry the frozen body.
      throw new BizConnectNotificationError("BizConnect notification response read failed", response.status, null, true);
    }
    try {
      if (text) payload = JSON.parse(text);
    } catch {
      if (response.status === 202 || response.status === 200) {
        throw new BizConnectNotificationError("Invalid BizConnect notification response", response.status);
      }
    }
    if (response.status !== 202 && !(response.status === 200 &&
        (object(object(payload)?.["data"]) ?? object(payload))?.["duplicate"] === true)) {
      throw new BizConnectNotificationError(
        `BizConnect notification failed (HTTP ${response.status})`,
        response.status,
        safeErrorCode(payload, this.config),
      );
    }
    const data = object(payload);
    const result = object(data?.["data"]) ?? data;
    const rawId = result?.["delivery_id"];
    const deliveryId = typeof rawId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(rawId) &&
      !rawId.includes(this.config.clientId) && !rawId.includes(this.config.clientSecret) ? rawId : null;
    const status = typeof result?.["status"] === "string" ? result["status"] : null;
    return { deliveryId, status, duplicate: response.status === 200 || result?.["duplicate"] === true, idempotencyKey };
  }
}