import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const outfile = fileURLToPath(new URL("../dist/bizconnect-notification-client-test.mjs", import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/bizconnect-notification-client.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const { BizConnectNotificationClient, BizConnectNotificationError, validateBizConnectNotificationConfig } =
  await import(pathToFileURL(outfile).href);

const config = { clientId: "test-client", clientSecret: "test-secret-value" };
const notification = {
  recipient_email: "user@example.com",
  subject: "Confirmation de paiement",
  title: "Paiement confirme",
  message: "OTP 548392: Votre paiement a ete confirme.",
  details: { Montant: "10 000 FCFA" },
  action_url: "https://example.com/transactions/84592",
  action_label: "Voir la transaction",
};
const json = (status, payload) => new Response(JSON.stringify(payload), {
  status,
  headers: { "Content-Type": "application/json" },
});

test("configuration is optional when unused but partial or enabled configuration fails at startup", () => {
  assert.equal(validateBizConnectNotificationConfig({}), null);
  assert.throws(() => validateBizConnectNotificationConfig({ BIZCONNECT_CLIENT_ID: "only-id" }), /required/);
  assert.throws(() => validateBizConnectNotificationConfig({ BIZCONNECT_NOTIFICATIONS_ENABLED: "true" }), /required/);
  assert.deepEqual(validateBizConnectNotificationConfig({
    BIZCONNECT_CLIENT_ID: config.clientId,
    BIZCONNECT_CLIENT_SECRET: config.clientSecret,
  }), config);
  assert.throws(() => new BizConnectNotificationClient({ config: { clientId: "", clientSecret: "" } }), /not configured/);
});

test("sends the typed payload and explicit idempotency key; parses success", async () => {
  const calls = [];
  const client = new BizConnectNotificationClient({
    config,
    http: async (url, init) => {
      calls.push({ url, init });
      return json(201, { data: { delivery_id: "del-123", status: "queued", duplicate: false } });
    },
  });
  const result = await client.sendEmail(notification, "payment-confirmed:transaction-84592");
  assert.deepEqual(result, {
    deliveryId: "del-123", status: "queued", duplicate: false,
    idempotencyKey: "payment-confirmed:transaction-84592",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.bizconnectacademy.com/api/v2/external/notifications/email");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["X-BCA-Client-ID"], config.clientId);
  assert.equal(calls[0].init.headers["X-BCA-Client-Secret"], config.clientSecret);
  assert.equal(calls[0].init.headers["Idempotency-Key"], result.idempotencyKey);
  assert.deepEqual(JSON.parse(calls[0].init.body), notification);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("generates a key and reports a duplicate delivery on a retry", async () => {
  const keys = [];
  const client = new BizConnectNotificationClient({
    config,
    http: async (_url, init) => {
      keys.push(init.headers["Idempotency-Key"]);
      return json(200, { delivery_id: "del-original", status: "sent", duplicate: true });
    },
  });
  const first = await client.sendEmail(notification);
  assert.match(first.idempotencyKey, /^[0-9a-f-]{36}$/);
  const second = await client.sendEmail(notification, first.idempotencyKey);
  assert.equal(second.duplicate, true);
  assert.deepEqual(keys, [first.idempotencyKey, first.idempotencyKey]);
});

test("parses HTTP errors without echoing sensitive provider content", async () => {
  const client = new BizConnectNotificationClient({
    config,
    http: async () => json(422, {
      error: { code: "INVALID_RECIPIENT", message: `OTP 548392, ${config.clientSecret}` },
    }),
  });
  await assert.rejects(client.sendEmail(notification, "payment:84592"), error => {
    assert.ok(error instanceof BizConnectNotificationError);
    assert.equal(error.httpStatus, 422);
    assert.equal(error.code, "INVALID_RECIPIENT");
    assert.doesNotMatch(error.message, /548392|test-secret-value|user@example\.com/);
    return true;
  });
});

test("drops provider error codes containing an OTP and never forwards unknown payload fields", async () => {
  let sentBody;
  const client = new BizConnectNotificationClient({
    config,
    http: async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return json(400, { code: "OTP_548392" });
    },
  });
  await assert.rejects(client.sendEmail({ ...notification, extra_private_field: "must-not-send" }), error => {
    assert.equal(error.code, null);
    assert.doesNotMatch(error.message, /548392/);
    return true;
  });
  assert.equal(sentBody.extra_private_field, undefined);
});

test("rejects malformed success and non-JSON errors without exposing response bodies", async () => {
  const malformed = new BizConnectNotificationClient({ config, http: async () => json(200, { status: "sent" }) });
  await assert.rejects(malformed.sendEmail(notification), /Invalid BizConnect notification response/);
  const invalidJson = new BizConnectNotificationClient({
    config,
    http: async () => new Response(`OTP 548392 ${config.clientSecret}`, { status: 500 }),
  });
  await assert.rejects(invalidJson.sendEmail(notification), error => {
    assert.equal(error.httpStatus, 500);
    assert.doesNotMatch(error.message, /548392|test-secret-value/);
    return true;
  });
});

test("times out and rejects invalid keys or payloads before calling HTTP", async () => {
  let attempts = 0;
  const client = new BizConnectNotificationClient({
    config,
    timeoutMs: 20,
    http: async (_url, init) => {
      attempts++;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
  });
  await assert.rejects(client.sendEmail(notification, "bad key"), /Invalid Idempotency-Key/);
  await assert.rejects(client.sendEmail({ ...notification, recipient_email: "invalid" }), /Invalid BizConnect email notification/);
  assert.equal(attempts, 0);
  await assert.rejects(client.sendEmail(notification), error => {
    assert.equal(error.httpStatus, null);
    assert.doesNotMatch(error.message, /548392|test-secret-value/);
    return true;
  });
  assert.equal(attempts, 1);
});