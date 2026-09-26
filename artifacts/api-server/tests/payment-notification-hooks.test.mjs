import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const outdir = fileURLToPath(new URL("../dist/payment-notification-hooks/", import.meta.url));
await build({
  entryPoints: [
    fileURLToPath(new URL("../src/lib/deposits.ts", import.meta.url)),
    fileURLToPath(new URL("../src/lib/izipay.ts", import.meta.url)),
  ],
  outdir, outExtension: { ".js": ".mjs" }, bundle: true,
  platform: "node", format: "esm", logLevel: "silent",
  plugins: [{
    name: "payment-hook-isolation",
    setup(b) {
      b.onResolve({ filter: /^\.\/(mysql|logger|referrals|notification-outbox)$/ }, args => ({
        path: args.path, namespace: "payment-stub",
      }));
      b.onLoad({ filter: /.*/, namespace: "payment-stub" }, args => ({
        contents: ({
          "./mysql": "export const getMysqlPool = () => globalThis.__paymentDb;",
          "./logger": "export const logger = { info() {}, warn() {}, error() {} };",
          "./referrals": "export const maybeAwardReferralBonus = async (...args) => globalThis.__referrals.push(args);",
          "./notification-outbox": `export const enqueueUserNotification = async (...args) => {
            globalThis.__notifications.push({
              connection: args[0], userId: args[1], key: args[2], content: args[3],
              committed: globalThis.__paymentEvents.includes("commit"),
            });
            globalThis.__paymentEvents.push("enqueue");
          };`,
        })[args.path],
        loader: "js",
      }));
    },
  }],
});
const { creditDeposit } = await import(pathToFileURL(`${outdir}/deposits.mjs`).href);
const { reconcileCryptoPayment } = await import(pathToFileURL(`${outdir}/izipay.mjs`).href);

function fixture(payment, { duplicate = false } = {}) {
  const events = [];
  globalThis.__paymentEvents = events;
  globalThis.__notifications = [];
  globalThis.__referrals = [];
  const conn = {
    async beginTransaction() { events.push("begin"); },
    async commit() { events.push("commit"); },
    async rollback() { events.push("rollback"); },
    release() { events.push("release"); },
    async execute(sql, args) {
      events.push(sql);
      if (sql.includes("SELECT * FROM payments") && sql.includes("FOR UPDATE")) return [[payment]];
      if (sql.includes("SELECT balance_minor FROM profiles")) return [[{ balance_minor: 100_000 }]];
      if (sql.includes("SELECT balance_usd_minor FROM profiles")) return [[{ balance_usd_minor: 20_000 }]];
      if (sql.includes("INSERT IGNORE INTO wallet_transactions")) return [{ affectedRows: duplicate ? 0 : 1 }];
      return [{ affectedRows: 1 }];
    },
  };
  globalThis.__paymentDb = {
    async getConnection() { return conn; },
    async execute(sql) {
      events.push(sql);
      if (sql.includes("FROM settings")) return [[]];
      if (sql.includes("FROM payments")) return [[payment]];
      throw new Error(`Unexpected pool SQL: ${sql}`);
    },
  };
  return { conn, events, notifications: globalThis.__notifications };
}

const fiat = (overrides = {}) => ({
  id: "fiat-1", user_id: "user-1", amount_minor: 600_000, status: "pending",
  provider: "afribapay", method: "afribapay", reference: "fiat-ref",
  currency: "XAF", country: "CM", created_at: new Date(), credited_at: null,
  bonus_status: null, ...overrides,
});
const cryptoPayment = (overrides = {}) => ({
  id: "crypto-1", user_id: "user-2", amount_minor: 10_000, fee_minor: 150,
  charge_minor: 10_150, provider: "izipay", provider_reference: "pi_test",
  order_id: "order-1", reference: "crypto-ref", credited_at: null, ...overrides,
});
const intent = (overrides = {}) => ({
  id: "pi_test", merchantReference: "order-1", status: "completed",
  currencyRequested: "USD", requestedCurrencyType: "fiat", amountRequested: "101.50",
  paymentResult: "exact", irregularStatus: "none", ...overrides,
});
const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.__paymentDb;
  delete globalThis.__paymentEvents;
  delete globalThis.__notifications;
  delete globalThis.__referrals;
});

test("fiat credit queues confirmation on the payment transaction before commit", async () => {
  const { conn, events, notifications } = fixture(fiat());
  const outcome = await creditDeposit("fiat-1");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.amountCredited, 6000);
  assert.equal(notifications.length, 1);
  const [note] = notifications;
  assert.equal(note.connection, conn);
  assert.equal(note.userId, "user-1");
  assert.equal(note.key, "payment-confirmed-fiat-1");
  assert.equal(note.committed, false);
  assert.match(note.content.details["Montant crédité"], /6.000 FCFA/);
  assert.equal(note.content.details["Référence"], "fiat-ref");
  assert.ok(events.indexOf("enqueue") > events.findIndex(e => e.includes("UPDATE payments SET status='completed'")));
  assert.ok(events.indexOf("enqueue") < events.indexOf("commit"));
});

test("fiat already credited, only-bonus, and duplicate wallet transaction do not enqueue", async () => {
  for (const [row, opts, dbOpts] of [
    [fiat({ credited_at: new Date() }), undefined, {}],
    [fiat({ credited_at: new Date(), bonus_status: "pending" }), { forceBonusCredit: true }, {}],
    [fiat(), undefined, { duplicate: true }],
    [fiat({ provider: "izipay" }), undefined, {}],
  ]) {
    const { notifications } = fixture(row, dbOpts);
    const result = await creditDeposit("fiat-1", opts);
    assert.equal(notifications.length, 0);
    if (row.provider === "izipay") assert.equal(result.ok, false);
    else assert.equal(result.alreadyCredited, Boolean(row.credited_at && !opts) || Boolean(dbOpts.duplicate));
  }
});

test("crypto completed exact payment queues once in its transaction before commit", async () => {
  process.env.IZIPAY_API_KEY = "sk_test_local";
  globalThis.fetch = async () => ({ ok: true, json: async () => intent() });
  const { conn, events, notifications } = fixture(cryptoPayment());
  assert.equal(await reconcileCryptoPayment("crypto-1"), "completed");
  assert.equal(notifications.length, 1);
  const [note] = notifications;
  assert.equal(note.connection, conn);
  assert.equal(note.userId, "user-2");
  assert.equal(note.key, "payment-confirmed-crypto-1");
  assert.equal(note.committed, false);
  assert.equal(note.content.details["Montant crédité"], "100.00 USD");
  assert.equal(note.content.details["Référence"], "crypto-ref");
  assert.ok(events.indexOf("enqueue") > events.findIndex(e => e.includes("UPDATE payments SET status='completed'")));
  assert.ok(events.indexOf("enqueue") < events.indexOf("commit"));
});

test("crypto credited, irregular and pending outcomes never queue a confirmation", async () => {
  process.env.IZIPAY_API_KEY = "sk_test_local";
  for (const [row, provider, expected] of [
    [cryptoPayment({ credited_at: new Date() }), intent(), "completed"],
    [cryptoPayment(), intent({ status: "irregular" }), "irregular"],
    [cryptoPayment(), intent({ status: "completed", paymentResult: "underpaid" }), "irregular"],
    [cryptoPayment(), intent({ status: "pending" }), "pending"],
  ]) {
    globalThis.fetch = async () => ({ ok: true, json: async () => provider });
    const { notifications } = fixture(row);
    assert.equal(await reconcileCryptoPayment("crypto-1"), expected);
    assert.equal(notifications.length, 0);
  }
});

test("crypto amount mismatch rejects before starting a transaction and never enqueues", async () => {
  process.env.IZIPAY_API_KEY = "sk_test_local";
  globalThis.fetch = async () => ({ ok: true, json: async () => intent({ amountRequested: "100.00" }) });
  const { events, notifications } = fixture(cryptoPayment());
  await assert.rejects(reconcileCryptoPayment("crypto-1"), /Incohérence/);
  assert.equal(events.includes("begin"), false);
  assert.equal(notifications.length, 0);
});