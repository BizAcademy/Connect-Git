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
  recipient_name: "Customer Name",
  preheader: "Payment update",
  category: "Notification",
  subtitle: "Your receipt",
  details: { Montant: "10 000 FCFA" },
  otp_code: "548392",
  expires_at: "2026-01-01T00:00:00Z",
  action_url: "https://example.com/transactions/84592",
  action_label: "Voir la transaction",
  note: "Thank you",
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
  assert.deepEqual(validateBizConnectNotificationConfig({
    BCA_NOTIFICATION_CLIENT_ID: "canonical-id",
    BCA_NOTIFICATION_CLIENT_SECRET: "canonical-secret",
    BCA_NOTIFICATION_ENDPOINT: "https://example.org/notify",
    BIZCONNECT_CLIENT_ID: config.clientId,
    BIZCONNECT_CLIENT_SECRET: config.clientSecret,
  }), { clientId: "canonical-id", clientSecret: "canonical-secret", endpoint: "https://example.org/notify" });
  assert.throws(() => validateBizConnectNotificationConfig({
    BCA_NOTIFICATION_CLIENT_ID: "canonical-id",
    BIZCONNECT_CLIENT_SECRET: config.clientSecret,
  }), /BCA_NOTIFICATION_CLIENT_SECRET/);
  assert.throws(() => validateBizConnectNotificationConfig({
    BCA_NOTIFICATION_CLIENT_ID: "canonical-id",
    BCA_NOTIFICATION_CLIENT_SECRET: "canonical-secret",
    BCA_NOTIFICATION_ENDPOINT: "http://example.org/notify",
  }), /endpoint/);
  assert.throws(() => new BizConnectNotificationClient({
    config: { ...config, endpoint: "https://user:password@example.org/notify" },
  }), /endpoint/);
  assert.throws(() => new BizConnectNotificationClient({ config: { clientId: "", clientSecret: "" } }), /not configured/);
});

test("sends all documented fields and explicit idempotency key; parses 202 success", async () => {
  const calls = [];
  const client = new BizConnectNotificationClient({
    config: { ...config, endpoint: "https://example.org/notify" },
    http: async (url, init) => {
      calls.push({ url, init });
      return json(202, { data: { delivery_id: "del-123", status: "queued", duplicate: false } });
    },
  });
  const result = await client.sendEmail(notification, "payment-confirmed:transaction-84592");
  assert.deepEqual(result, {
    deliveryId: "del-123", status: "queued", duplicate: false,
    idempotencyKey: "payment-confirmed:transaction-84592",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.org/notify");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(calls[0].init.headers["X-BCA-Client-ID"], config.clientId);
  assert.equal(calls[0].init.headers["X-BCA-Client-Secret"], config.clientSecret);
  assert.equal(calls[0].init.headers["Idempotency-Key"], result.idempotencyKey);
  assert.deepEqual(JSON.parse(calls[0].init.body), notification);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("requires a stable key and reports a 200 duplicate without required metadata", async () => {
  const keys = [];
  const client = new BizConnectNotificationClient({
    config,
    http: async (_url, init) => {
      keys.push(init.headers["Idempotency-Key"]);
      return json(200, { duplicate: true });
    },
  });
  await assert.rejects(client.sendEmail(notification), /Invalid Idempotency-Key/);
  const first = await client.sendEmail(notification, "payment-confirmed-84592");
  const second = await client.sendEmail(notification, "payment-confirmed-84592");
  assert.deepEqual(first, {
    deliveryId: null, status: null, duplicate: true, idempotencyKey: "payment-confirmed-84592",
  });
  assert.deepEqual(keys, [first.idempotencyKey, second.idempotencyKey]);
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
    assert.equal(error.retryable, false);
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
  await assert.rejects(client.sendEmail({ ...notification, extra_private_field: "must-not-send",
    platform_name: "not allowed", support_email: "private@example.com" }, "payment:84592"), error => {
    assert.equal(error.code, null);
    assert.doesNotMatch(error.message, /548392/);
    return true;
  });
  assert.equal(sentBody.extra_private_field, undefined);
  assert.equal(sentBody.platform_name, undefined);
  assert.equal(sentBody.support_email, undefined);
});

test("only 202 or 200 duplicate true succeed, with optional success metadata", async () => {
  for (const status of [200, 201, 204, 302]) {
    const client = new BizConnectNotificationClient({ config, http: async () =>
      status === 204 ? new Response(null, { status }) : json(status, { status: "sent" }) });
    await assert.rejects(client.sendEmail(notification, "payment:84592"), error => {
      assert.equal(error.httpStatus, status);
      assert.equal(error.retryable, false);
      return true;
    });
  }
  const accepted = new BizConnectNotificationClient({
    config, http: async () => new Response(null, { status: 202 }),
  });
  assert.deepEqual(await accepted.sendEmail(notification, "payment:84592"), {
    deliveryId: null, status: null, duplicate: false, idempotencyKey: "payment:84592",
  });
});

test("classifies 5xx errors without exposing response bodies", async () => {
  const invalidJson = new BizConnectNotificationClient({
    config,
    http: async () => new Response(`OTP 548392 ${config.clientSecret}`, { status: 500 }),
  });
  await assert.rejects(invalidJson.sendEmail(notification, "payment:84592"), error => {
    assert.equal(error.httpStatus, 500);
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /548392|test-secret-value/);
    return true;
  });
});

test("authentication and idempotency conflicts are not retryable; queue failures are", async () => {
  for (const [status, retryable] of [[401, false], [409, false], [422, false], [503, true]]) {
    const client = new BizConnectNotificationClient({
      config, http: async () => json(status, { error: { message: config.clientSecret } }),
    });
    await assert.rejects(client.sendEmail(notification, "payment:84592"), error => {
      assert.equal(error.httpStatus, status);
      assert.equal(error.retryable, retryable);
      assert.doesNotMatch(error.message, /test-secret-value/);
      return true;
    });
  }
});

test("invalid duplicate JSON cannot be treated as accepted", async () => {
  const client = new BizConnectNotificationClient({
    config, http: async () => new Response("invalid JSON", { status: 200 }),
  });
  await assert.rejects(client.sendEmail(notification, "payment:84592"), error => {
    assert.equal(error.httpStatus, 200);
    assert.equal(error.retryable, false);
    return true;
  });
});

test("body stream failures are retryable even after accepted headers", async () => {
  for (const status of [202, 503]) {
    const client = new BizConnectNotificationClient({
      config,
      http: async () => ({
        status,
        text: async () => { throw new Error(`stream failed: ${config.clientSecret}`); },
      }),
    });
    await assert.rejects(client.sendEmail(notification, "payment:84592"), error => {
      assert.equal(error.httpStatus, status);
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /test-secret-value/);
      return true;
    });
  }
});

test("malformed JSON after 202 is not retryable", async () => {
  const client = new BizConnectNotificationClient({
    config, http: async () => new Response("invalid JSON", { status: 202 }),
  });
  await assert.rejects(client.sendEmail(notification, "payment:84592"), error => {
    assert.equal(error.httpStatus, 202);
    assert.equal(error.retryable, false);
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
  await assert.rejects(client.sendEmail(notification, "payment:84592"), error => {
    assert.equal(error.httpStatus, null);
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /548392|test-secret-value/);
    return true;
  });
  assert.equal(attempts, 1);
});

test("deadline also applies while reading the body, and does not retry", async () => {
  let calls = 0;
  const client = new BizConnectNotificationClient({
    config,
    timeoutMs: 20,
    http: async () => {
      calls++;
      return { status: 202, text: () => new Promise(() => {}) };
    },
  });
  await assert.rejects(client.sendEmail(notification, "payment:84592"), error => {
    assert.equal(error.httpStatus, null);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(calls, 1);
});

test("network errors are sanitized, including when the fetch error contains credentials", async () => {
  const client = new BizConnectNotificationClient({
    config, http: async () => { throw new Error(`secret: ${config.clientSecret}`); },
  });
  await assert.rejects(client.sendEmail(notification, "payment:84592"), error => {
    assert.equal(error.retryable, true);
    assert.equal(error.httpStatus, null);
    assert.doesNotMatch(error.message, /test-secret-value/);
    return true;
  });
});