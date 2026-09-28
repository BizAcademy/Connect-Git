const ENDPOINT = "https://send.api.mailtrap.io/api/send";
const DEFAULT_TIMEOUT_MS = 10_000;

/** The application's provider-independent, frozen email content. */
export interface NotificationEmail {
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

export interface MailtrapDelivery {
  deliveryId: string;
}

export interface MailtrapConfig {
  apiToken: string;
  fromEmail: string;
  fromName: string;
}

/** An absent integration is optional, but a partial one must not start. */
export function validateMailtrapConfig(env: NodeJS.ProcessEnv = process.env): MailtrapConfig | null {
  const apiToken = env["MAILTRAP_API_TOKEN"]?.trim();
  const fromEmail = env["MAILTRAP_FROM_EMAIL"]?.trim();
  const fromName = env["MAILTRAP_FROM_NAME"]?.trim() || "BUZZ BOOSTER";
  if (apiToken === undefined && fromEmail === undefined) return null;
  if (!apiToken || !fromEmail) throw new Error("MAILTRAP_API_TOKEN and MAILTRAP_FROM_EMAIL are required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail) ||
      /[\r\n]/.test(apiToken + fromName) || !fromName) {
    throw new Error("Invalid Mailtrap notification configuration");
  }
  return { apiToken, fromEmail, fromName };
}

export class MailtrapNotificationError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null,
    public readonly retryable: boolean = httpStatus === null || httpStatus === 408 ||
      httpStatus === 429 || httpStatus >= 500,
  ) {
    super(message);
    this.name = "MailtrapNotificationError";
  }
}

function validateNotification(input: NotificationEmail): void {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      typeof input.recipient_email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.recipient_email) ||
      ![input.subject, input.title, input.message].every(value => typeof value === "string" && value.trim().length > 0) ||
      (input.details !== undefined && (typeof input.details !== "object" ||
        input.details === null || Array.isArray(input.details) ||
        !Object.entries(input.details).every(([key, value]) => key.length > 0 && typeof value === "string"))) ||
      !["recipient_name", "preheader", "category", "subtitle", "otp_code", "expires_at", "action_label", "note"]
        .every(key => input[key as keyof NotificationEmail] === undefined ||
          typeof input[key as keyof NotificationEmail] === "string") ||
      (input.action_url !== undefined && (typeof input.action_url !== "string" ||
        !/^https:\/\//.test(input.action_url)))) {
    throw new TypeError("Invalid notification email");
  }
}

function plainText(input: NotificationEmail): string {
  const sections = [
    input.title,
    input.subtitle,
    input.message,
    input.details && Object.entries(input.details).map(([key, value]) => `${key}: ${value}`).join("\n"),
    input.action_url && `${input.action_label || "Ouvrir le lien"} : ${input.action_url}`,
    input.note,
  ];
  return sections.filter(Boolean).join("\n\n");
}

/** The outbox owns retries. Mailtrap does not document an idempotency key. */
export class MailtrapNotificationClient {
  private readonly config: MailtrapConfig;
  private readonly http: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { config?: MailtrapConfig; http?: typeof fetch; timeoutMs?: number } = {}) {
    const config = options.config ?? validateMailtrapConfig();
    if (!config?.apiToken || !config.fromEmail) throw new Error("Mailtrap notifications are not configured");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("Invalid notification timeout");
    this.config = config;
    this.http = options.http ?? fetch;
    this.timeoutMs = timeoutMs;
  }

  async sendEmail(input: NotificationEmail): Promise<MailtrapDelivery> {
    validateNotification(input);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.request(input, controller.signal), timeout]);
    } catch (error) {
      if (error instanceof MailtrapNotificationError) throw error;
      // Do not expose provider errors: they may echo the token, OTP or recipient.
      throw new MailtrapNotificationError("Mailtrap notification request failed or timed out", null);
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(input: NotificationEmail, signal: AbortSignal): Promise<MailtrapDelivery> {
    const response = await this.http(ENDPOINT, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Api-Token": this.config.apiToken,
        "User-Agent": "BuzzBooster-Notifications/1.0",
      },
      body: JSON.stringify({
        from: { email: this.config.fromEmail, name: this.config.fromName },
        to: [{ email: input.recipient_email,
          ...(input.recipient_name ? { name: input.recipient_name } : {}) }],
        subject: input.subject,
        text: plainText(input),
        ...(input.category ? { category: input.category } : {}),
      }),
      signal,
    });
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new MailtrapNotificationError("Mailtrap response read failed", response.status, true);
    }
    if (response.status !== 200) {
      throw new MailtrapNotificationError(`Mailtrap notification failed (HTTP ${response.status})`, response.status);
    }
    let result: unknown;
    try { result = JSON.parse(text); }
    catch { throw new MailtrapNotificationError("Invalid Mailtrap acceptance response", 200, true); }
    const data = result !== null && typeof result === "object" && !Array.isArray(result)
      ? result as Record<string, unknown> : null;
    const ids = data?.["message_ids"];
    if (data?.["success"] !== true || !Array.isArray(ids) || ids.length !== 1 ||
        typeof ids[0] !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(ids[0]) ||
        ids[0].includes(this.config.apiToken)) {
      throw new MailtrapNotificationError("Invalid Mailtrap acceptance response", 200, true);
    }
    return { deliveryId: ids[0] };
  }
}