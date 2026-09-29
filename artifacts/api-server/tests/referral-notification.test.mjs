import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const outdir = fileURLToPath(new URL("../dist/referral-notification/", import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/referrals.ts", import.meta.url))],
  outdir, outExtension: { ".js": ".mjs" }, bundle: true,
  platform: "node", format: "esm", logLevel: "silent",
  plugins: [{
    name: "referral-notification-isolation",
    setup(b) {
      b.onResolve({ filter: /^\.\/(mysql|logger|notification-outbox)$/ }, args => ({
        path: args.path, namespace: "referral-stub",
      }));
      b.onLoad({ filter: /.*/, namespace: "referral-stub" }, args => ({
        contents: ({
          "./mysql": "export const getMysqlPool = () => globalThis.__referralDb;",
          "./logger": "export const logger = { info() {}, warn() {}, error() {} };",
          "./notification-outbox": `export const enqueueUserNotification = async (...args) => {
            if (globalThis.__referralFailNotification) {
              globalThis.__referralFailNotification = false;
              throw new Error("notification enqueue failed");
            }
            globalThis.__referralNotifications.push({
              connection: args[0], userId: args[1], key: args[2], content: args[3],
              committed: globalThis.__referralEvents.includes("commit"),
            });
            globalThis.__referralEvents.push("enqueue");
          };`,
        })[args.path],
        loader: "js",
      }));
    },
  }],
});
const { maybeAwardReferralBonus } = await import(pathToFileURL(`${outdir}/referrals.mjs`).href);
const { recoverStuckReferrals } = await import(pathToFileURL(`${outdir}/referrals.mjs`).href);

function referral(overrides = {}) {
  return {
    id: "referral-123", referrer_user_id: "referrer-1", referred_user_id: "referred-1",
    status: "pending", referrer_bonus_minor: null, referred_bonus_minor: null,
    referrer_credited_at: null, referred_credited_at: null, ...overrides,
  };
}

function fixture({ row = referral(), duplicateReferrer = false } = {}) {
  const events = [];
  const notifications = [];
  globalThis.__referralEvents = events;
  globalThis.__referralNotifications = notifications;
  const conn = {
    async beginTransaction() { events.push("begin"); },
    async commit() { events.push("commit"); },
    async rollback() { events.push("rollback"); },
    release() { events.push("release"); },
    async execute(sql, args) {
      events.push(sql);
      if (sql.includes("SELECT * FROM referrals")) return [row && row.status !== "paid" ? [row] : []];
      if (sql.includes("SELECT user_id,balance_minor FROM profiles")) return [[
        { user_id: "referrer-1", balance_minor: 100_000 },
        { user_id: "referred-1", balance_minor: 50_000 },
      ]];
      if (sql.includes("INSERT IGNORE INTO wallet_transactions")) {
        const type = args[4];
        return [{ affectedRows: duplicateReferrer && type === "referral_referrer_bonus" ? 0 : 1 }];
      }
      if (sql.includes("UPDATE referrals SET status='paid'")) row.status = "paid";
      return [{ affectedRows: 1 }];
    },
  };
  globalThis.__referralDb = {
    async getConnection() { return conn; },
    async execute(sql) {
      if (sql.includes("FROM settings")) return [[]];
      throw new Error(`Unexpected pool SQL: ${sql}`);
    },
  };
  return { conn, events, notifications };
}

test.after(() => {
  delete globalThis.__referralDb;
  delete globalThis.__referralEvents;
  delete globalThis.__referralNotifications;
  delete globalThis.__referralFailNotification;
});

test("new referral credit queues one French commission notification in its transaction", async () => {
  const { conn, events, notifications } = fixture();
  await maybeAwardReferralBonus("referred-1", "payment-1", 10_000);

  assert.equal(notifications.length, 1);
  const [note] = notifications;
  assert.equal(note.connection, conn);
  assert.equal(note.userId, "referrer-1");
  assert.equal(note.key, "referral-commission-referral-123");
  assert.equal(note.committed, false);
  assert.equal(note.content.category, "Transaction");
  assert.match(note.content.subject, /commission/i);
  assert.match(note.content.title, /commission/i);
  assert.equal(note.content.details["Montant crédité"], "500 FCFA");
  assert.ok(events.indexOf("enqueue") < events.indexOf("commit"));

  // Once paid, a repeated call cannot claim the referral or enqueue again.
  await maybeAwardReferralBonus("referred-1", "payment-1", 10_000);
  assert.equal(notifications.length, 1);
});

test("duplicate wallet credit does not notify, but a recovered credit does", async () => {
  const duplicate = fixture({ duplicateReferrer: true });
  await maybeAwardReferralBonus("referred-1", "payment-1", 10_000);
  assert.equal(duplicate.notifications.length, 0);

  const recovery = fixture({
    row: referral({
      status: "processing", referrer_bonus_minor: 50_000, referred_bonus_minor: 20_000,
    }),
  });
  await maybeAwardReferralBonus("referred-1", "payment-1", 10_000);
  assert.equal(recovery.notifications.length, 1);
  assert.equal(recovery.notifications[0].userId, "referrer-1");
});

test("pending referral is recovered after enqueue failure using credited deposit FCFA amount", async () => {
  let savedReferral = referral();
  let txReferral = null;
  let txReferrerCredited = false;
  let committedReferrerCredits = 0;
  const events = [];
  const notifications = [];
  globalThis.__referralEvents = events;
  globalThis.__referralNotifications = notifications;
  globalThis.__referralFailNotification = true;
  const conn = {
    async beginTransaction() { txReferral = { ...savedReferral }; txReferrerCredited = false; events.push("begin"); },
    async commit() {
      savedReferral = txReferral;
      if (txReferrerCredited) committedReferrerCredits++;
      events.push("commit");
    },
    async rollback() { txReferral = null; txReferrerCredited = false; events.push("rollback"); },
    release() { events.push("release"); },
    async execute(sql, args) {
      events.push(sql);
      if (sql.includes("SELECT * FROM referrals")) return [[{ ...txReferral }]];
      if (sql.includes("SELECT user_id,balance_minor FROM profiles")) return [[
        { user_id: "referrer-1", balance_minor: 100_000 },
        { user_id: "referred-1", balance_minor: 50_000 },
      ]];
      if (sql.includes("UPDATE referrals SET status='processing'")) {
        Object.assign(txReferral, {
          status: "processing", qualifying_payment_id: args[0], qualifying_amount_minor: args[1],
          referrer_bonus_minor: args[2], referred_bonus_minor: args[3],
        });
      }
      if (sql.includes("INSERT IGNORE INTO wallet_transactions")) {
        if (args[4] === "referral_referrer_bonus") txReferrerCredited = true;
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("UPDATE referrals SET status='paid'")) txReferral.status = "paid";
      return [{ affectedRows: 1 }];
    },
  };
  globalThis.__referralDb = {
    async getConnection() { return conn; },
    async execute(sql) {
      if (sql.includes("FROM settings")) return [[]];
      if (sql.includes("status='processing'")) return [[]];
      if (sql.includes("status='pending'")) return savedReferral.status === "pending" ? [[{
        id: savedReferral.id, referred_user_id: savedReferral.referred_user_id,
      }]] : [[]];
      if (sql.includes("FROM payments")) return [[
        { id: "below-threshold", amount_minor: 200_000, currency: "XOF", country: "SN" },
        { id: "qualifying-payment", amount_minor: 300_000, currency: "XOF", country: "SN" },
      ]];
      throw new Error(`Unexpected pool SQL: ${sql}`);
    },
  };

  await maybeAwardReferralBonus("referred-1", "original-payment", 6_000);
  assert.equal(savedReferral.status, "pending", "notification failure rolls back referral credit");
  assert.equal(committedReferrerCredits, 0);
  assert.equal(events.includes("rollback"), true);

  await recoverStuckReferrals();
  assert.equal(savedReferral.status, "paid");
  assert.equal(savedReferral.qualifying_payment_id, "qualifying-payment");
  assert.equal(savedReferral.qualifying_amount_minor, 270_000, "3,000 XOF converts to 2,700 FCFA");
  assert.equal(committedReferrerCredits, 1);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].key, "referral-commission-referral-123");
  assert.equal(notifications[0].content.details["Montant crédité"], "135 FCFA");

  await recoverStuckReferrals();
  assert.equal(committedReferrerCredits, 1, "recovery is idempotent after payout");
  assert.equal(notifications.length, 1);
  delete globalThis.__referralFailNotification;
});