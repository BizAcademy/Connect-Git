const DEFAULT_SABITO_URL = "https://sabito.bizconnectacademy.com";

export type SabitoSession = {
  access_token: string;
  expires_in: number;
  socket_path: string;
  external_user_id: string;
};

type SabitoConfig = { url?: string; clientId?: string; clientSecret?: string };
type ErrorCode = "CONFIGURATION" | "IDENTITY" | "UPSTREAM" | "RESPONSE" | "TIMEOUT";

export class SabitoSessionError extends Error {
  constructor(public readonly code: ErrorCode, public readonly status: number) {
    // Never retain an upstream body, token, Basic header or network error.
    super(`SABITO_${code}`);
  }
}

export async function exchangeSabitoSession(
  userId: string,
  signal?: AbortSignal,
  config: SabitoConfig = {
    url: process.env.SABITO_URL,
    clientId: process.env.SABITO_CLIENT_ID,
    clientSecret: process.env.SABITO_CLIENT_SECRET,
  },
  fetcher: typeof fetch = fetch,
): Promise<SabitoSession> {
  if (
    !userId || userId !== userId.trim() || userId.length > 191 ||
    userId === "sabito-admin-preview" || userId.startsWith("guest:")
  ) {
    throw new SabitoSessionError("IDENTITY", 502);
  }
  if (!config.clientId?.trim() || !config.clientSecret) {
    throw new SabitoSessionError("CONFIGURATION", 503);
  }

  let origin: URL;
  try {
    origin = new URL(config.url === undefined ? DEFAULT_SABITO_URL : config.url);
    if (
      origin.protocol !== "https:" || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash
    ) throw new Error("Invalid server origin");
  } catch {
    throw new SabitoSessionError("CONFIGURATION", 503);
  }

  const timeout = AbortSignal.timeout(10_000);
  const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  let result: unknown;
  try {
    response = await fetcher(new URL("/v1/auth/token", origin), {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      body: JSON.stringify({ external_user_id: userId }),
      signal: abortSignal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      // An upstream 401 concerns the platform credentials, not the member's
      // cookie. Returning 401 here would incorrectly sign the member out.
      throw new SabitoSessionError(
        "UPSTREAM", [429, 503].includes(response.status) ? 503 : 502,
      );
    }
    result = await response.json();
  } catch (error) {
    if (error instanceof SabitoSessionError) throw error;
    throw new SabitoSessionError(timeout.aborted ? "TIMEOUT" : "UPSTREAM", timeout.aborted ? 504 : 502);
  }

  if (!result || typeof result !== "object") throw new SabitoSessionError("RESPONSE", 502);
  const envelope = result as Record<string, unknown>;
  const data = envelope.data as Record<string, unknown> | null | undefined;
  if (
    envelope.success !== true || !data || typeof data !== "object" ||
    typeof data.access_token !== "string" || !data.access_token.trim() ||
    data.identity_type !== "platform_user" || data.external_user_id !== userId ||
    typeof data.expires_in !== "number" || !Number.isInteger(data.expires_in) ||
    data.expires_in < 1 || data.expires_in > 900 ||
    typeof data.socket_path !== "string" || !data.socket_path.startsWith("/") ||
    data.socket_path.startsWith("//") || /[\\?#\s]/.test(data.socket_path)
  ) {
    throw new SabitoSessionError("RESPONSE", 502);
  }

  return {
    access_token: data.access_token,
    expires_in: data.expires_in,
    socket_path: data.socket_path,
    external_user_id: userId,
  };
}
