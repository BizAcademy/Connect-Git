import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const outfile = fileURLToPath(new URL("../dist/mailtrap-notification-client-test.mjs", import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/mailtrap-notification-client.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent",
  loader: { ".png": "dataurl" },
});
const { MailtrapNotificationClient, MailtrapNotificationError, validateMailtrapConfig } =
  await import(pathToFileURL(outfile).href);

const config = { apiToken: "mailtrap-test-token", fromEmail: "hello@verified.example", fromName: "BUZZ BOOSTER" };
const notification = {
  recipient_email: "user@example.com", recipient_name: "Client",
  subject: "Votre code", title: "Vérification de votre adresse",
  message: "Saisissez le code 548392. Il expire dans 10 minutes.",
  otp_code: "548392", expires_at: "2026-01-01T00:00:00Z",
  details: { Type: "Inscription" },
  action_url: "https://example.com/verify", action_label: "Ouvrir",
  note: "Ne partagez pas ce code.", category: "security",
};
const json = (status, body) => new Response(JSON.stringify(body), { status });

test("disabled integration is optional but incomplete or invalid configuration fails", () => {
  assert.equal(validateMailtrapConfig({}), null);
  assert.throws(() => validateMailtrapConfig({ MAILTRAP_API_TOKEN: "only-token" }), /required/);
  assert.throws(() => validateMailtrapConfig({ MAILTRAP_FROM_EMAIL: "test@example.com" }), /required/);
  assert.throws(() => validateMailtrapConfig({
    MAILTRAP_API_TOKEN: "token", MAILTRAP_FROM_EMAIL: "bad address",
  }), /Invalid/);
  assert.deepEqual(validateMailtrapConfig({
    MAILTRAP_API_TOKEN: config.apiToken, MAILTRAP_FROM_EMAIL: config.fromEmail,
  }), config);
});

test("sends branded HTML and plain text with the actual logo inline", async () => {
  const calls = [];
  const client = new MailtrapNotificationClient({
    config, http: async (url, init) => {
      calls.push({ url, init });
      return json(200, { success: true, message_ids: ["mail-123"] });
    },
  });
  assert.deepEqual(await client.sendEmail({ ...notification, extra: "not forwarded" }), { deliveryId: "mail-123" });
  assert.equal(calls[0].url, "https://send.api.mailtrap.io/api/send");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers["Api-Token"], config.apiToken);
  assert.equal(calls[0].init.headers["Idempotency-Key"], undefined);
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual({
    ...sent, html: undefined, attachments: undefined,
  }, {
    from: { email: config.fromEmail, name: config.fromName },
    to: [{ email: notification.recipient_email, name: notification.recipient_name }],
    subject: notification.subject,
    text: "Vérification de votre adresse\n\nSaisissez le code 548392. Il expire dans 10 minutes.\n\nCode de vérification : 548392\n\nType: Inscription\n\nOuvrir : https://example.com/verify\n\nNe partagez pas ce code.",
    category: "security",
    html: undefined, attachments: undefined,
  });
  assert.match(sent.html, /cid:buzz-booster-logo/);
  assert.match(sent.html, /548392/);
  assert.match(sent.html, /Sécurité/);
  assert.equal(sent.attachments.length, 1);
  assert.equal(sent.attachments[0].disposition, "inline");
  assert.equal(sent.attachments[0].content_id, "buzz-booster-logo");
  assert.equal(sent.attachments[0].type, "image/png");
  assert.ok(Buffer.from(sent.attachments[0].content, "base64").length > 1000);
  assert.equal(sent.otp_code, undefined);
});

test("sends a PDF invoice alongside the inline logo and includes order links in email content", async () => {
  let sent;
  const client = new MailtrapNotificationClient({
    config, http: async (_url, init) => {
      sent = JSON.parse(init.body);
      return json(200, { success: true, message_ids: ["invoice-123"] });
    },
  });
  const url = "https://instagram.com/customer?ref=mail";
  const pdf = Buffer.from("%PDF-1.7\n%%EOF", "ascii").toString("base64");
  await client.sendEmail({
    ...notification,
    category: "Paiement",
    details: { "URL du compte ou de la publication": url },
    note: "Votre facture est jointe.",
    attachments: [{ filename: "facture-depot.pdf", type: "application/pdf", content: pdf }],
  });

  assert.equal(sent.attachments.length, 2);
  assert.equal(sent.attachments[1].filename, "facture-depot.pdf");
  assert.equal(sent.attachments[1].type, "application/pdf");
  assert.equal(sent.attachments[1].content, pdf);
  assert.match(sent.text, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(sent.html, /href="https:\/\/instagram\.com\/customer\?ref=mail"/);
  assert.match(sent.html, /Votre facture est jointe/);
});

test("escapes user content in both layouts while keeping the logo", async () => {
  const sent = [];
  const client = new MailtrapNotificationClient({
    config, http: async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return json(200, { success: true, message_ids: ["mail-123"] });
    },
  });
  await client.sendEmail({ ...notification, message: "<script>alert('x')</script>", otp_code: "548392" });
  await client.sendEmail({
    recipient_email: "user@example.com", subject: "Dépôt",
    title: "Dépôt confirmé", message: "Vous avez reçu <b>100</b> FCFA",
    details: { "Montant crédité": "100 <script> FCFA" }, category: "Paiement",
  });
  for (const request of sent) {
    assert.match(request.html, /cid:buzz-booster-logo/);
    assert.doesNotMatch(request.html, /<script>|<b>100<\/b>/);
  }
  assert.match(sent[1].html, /100 &lt;script&gt; FCFA/);
});

test("rejects missing success or invalid message IDs instead of treating HTTP 200 as delivery", async () => {
  for (const body of [{ success: false, errors: ["invalid"] }, { success: true, message_ids: [] },
    { success: true, message_ids: ["one", "two"] }, { success: true, message_ids: [config.apiToken] }]) {
    const client = new MailtrapNotificationClient({ config, http: async () => json(200, body) });
    await assert.rejects(client.sendEmail(notification), e => e instanceof MailtrapNotificationError &&
      e.httpStatus === 200 && !e.message.includes(config.apiToken));
  }
});

test("network and 429/5xx failures retry; authentication and validation errors do not", async () => {
  for (const [status, retryable] of [[401, false], [422, false], [429, true], [503, true]]) {
    const client = new MailtrapNotificationClient({
      config, http: async () => json(status, { errors: [`OTP 548392 ${config.apiToken}`] }),
    });
    await assert.rejects(client.sendEmail(notification), e => e instanceof MailtrapNotificationError &&
      e.httpStatus === status && e.retryable === retryable &&
      !/548392|mailtrap-test-token|user@example.com/.test(e.message));
  }
  const client = new MailtrapNotificationClient({
    config, http: async () => { throw new Error(config.apiToken); },
  });
  await assert.rejects(client.sendEmail(notification), e => e.retryable &&
    e.httpStatus === null && !e.message.includes(config.apiToken));
});

test("invalid payloads do not make HTTP calls and timeout includes response body", async () => {
  let calls = 0;
  const client = new MailtrapNotificationClient({
    config, timeoutMs: 20, http: async () => {
      calls++;
      return { status: 200, text: () => new Promise(() => {}) };
    },
  });
  await assert.rejects(client.sendEmail({ ...notification, recipient_email: "bad" }), /Invalid notification/);
  assert.equal(calls, 0);
  await assert.rejects(client.sendEmail(notification), e => e.retryable && e.httpStatus === null);
  assert.equal(calls, 1);
});