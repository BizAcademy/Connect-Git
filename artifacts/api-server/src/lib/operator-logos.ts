/**
 * Operator logo management — stores custom logo URLs in the `settings` table
 * under keys prefixed with `operator_logo_`.
 *
 * 30-second in-memory cache so admin changes are visible to users
 * within half a minute without hammering Supabase.
 */
import { logger } from "./logger";

const SUPABASE_URL = process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];

const KEY_PREFIX = "operator_logo_";
const CACHE_TTL_MS = 30_000;

function serviceRoleHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY!}`,
    "Content-Type": "application/json",
  };
}

interface LogosCache {
  value: Record<string, string>;
  expiresAt: number;
}
let cache: LogosCache | null = null;

export function bustOperatorLogosCache(): void {
  cache = null;
}

/** Returns a map of operatorCode → logo URL for all configured operators. */
export async function fetchOperatorLogos(): Promise<Record<string, string>> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return {};
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/settings?key=like.${encodeURIComponent(KEY_PREFIX + "*")}&select=key,value`,
      { headers: serviceRoleHeaders() },
    );
    if (!r.ok) return {};
    const rows = (await r.json()) as { key: string; value: string }[];
    const logos: Record<string, string> = {};
    for (const row of rows) {
      const code = row.key.slice(KEY_PREFIX.length);
      if (code && row.value) logos[code] = row.value;
    }
    cache = { value: logos, expiresAt: Date.now() + CACHE_TTL_MS };
    return logos;
  } catch (err) {
    logger.warn({ err }, "fetchOperatorLogos failed");
    return {};
  }
}

/** Save (upsert) a logo URL for a given operator code. */
export async function upsertOperatorLogo(operatorCode: string, logoUrl: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase service role not configured");
  }
  const key = KEY_PREFIX + operatorCode;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/settings`, {
    method: "POST",
    headers: {
      ...serviceRoleHeaders(),
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ key, value: logoUrl }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Supabase upsert failed (${r.status}): ${body.slice(0, 200)}`);
  }
  bustOperatorLogosCache();
}

const STORAGE_BUCKET = "operator-logos";

/**
 * Upload an image buffer to Supabase Storage (public bucket) and store the
 * resulting public URL in the settings table.
 * Returns the public URL of the uploaded image.
 */
export async function uploadOperatorLogoFile(
  operatorCode: string,
  fileBuffer: Buffer,
  mimeType: string,
): Promise<string> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase service role not configured");
  }
  const storageHeaders = {
    apikey: SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY!}`,
  };

  // Ensure the bucket exists (no-op if already created)
  await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: "POST",
    headers: { ...storageHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ id: STORAGE_BUCKET, name: STORAGE_BUCKET, public: true }),
  }).catch(() => {/* ignore — bucket likely exists */});

  const ext = mimeType.includes("svg")
    ? "svg"
    : mimeType.includes("png")
      ? "png"
      : "jpg";
  const objectPath = `${operatorCode}.${ext}`;

  const uploadRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${objectPath}`,
    {
      method: "POST",
      headers: {
        ...storageHeaders,
        "Content-Type": mimeType,
        "x-upsert": "true",
        "cache-control": "public, max-age=3600",
      },
      body: fileBuffer,
    },
  );
  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    throw new Error(`Storage upload failed (${uploadRes.status}): ${body.slice(0, 300)}`);
  }

  // Cache-bust with a timestamp so the browser picks up the new file immediately
  const publicUrl =
    `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${objectPath}?t=${Date.now()}`;
  await upsertOperatorLogo(operatorCode, publicUrl);
  return publicUrl;
}

/** Delete the custom logo for a given operator code (reverts to default). */
export async function deleteOperatorLogo(operatorCode: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase service role not configured");
  }
  const key = KEY_PREFIX + operatorCode;
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/settings?key=eq.${encodeURIComponent(key)}`,
    { method: "DELETE", headers: serviceRoleHeaders() },
  );
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Supabase delete failed (${r.status}): ${body.slice(0, 200)}`);
  }
  bustOperatorLogosCache();
}
