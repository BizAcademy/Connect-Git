import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";

const outfile = fileURLToPath(new URL("../dist/smm-order-completion-test.mjs", import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL("../src/routes/smm.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent",
  plugins: [{
    name: "smm-order-test-stubs",
    setup(b) {
      b.onResolve({ filter: /^(express|\.\.\/lib\/)/ }, args => ({
        path: args.path, namespace: "smm-test-stub",
      }));
      b.onLoad({ filter: /.*/, namespace: "smm-test-stub" }, args => {
        const stubs = {
          express: `export const Router=()=>({get(){},post(){}});`,
          "../lib/logger": `export const logger={warn(){},error(){}};`,
          "../lib/mysql": `export const getMysqlPool=()=>globalThis.__smmOrderTestDb;`,
          "../lib/auth": `export const requireUser=()=>{},requireAdmin=()=>{};`,
          "../lib/smm-pricing": `
            export const enrichServices=()=>[],defaultPriceFcfaForCurrency=()=>0,loadPricing=async()=>({}),
            getUsdRates=()=>({}),subscribeUsdRates=()=>()=>{},usdToLocalRate=()=>1;`,
          "../lib/smm-providers": `
            export const callProvider=async()=>({status:"Completed"}),getProvider=()=>({configured:true}),
            parseProviderId=()=>1,ALL_PROVIDER_IDS=[1],loadProviderConfig=async()=>[];
          `,
          "../lib/smm-status": `export const FINAL_REFUND_STATUSES=new Set(["refunded"]),mapProviderStatus=s=>s==="Completed"?"completed":s,isSupportedServiceType=()=>true;`,
          "../lib/earnings": `export const appendEarning=async()=>{},estimateGainFromRevenue=()=>({gain_fcfa:0,provider_cost_fcfa:0});`,
          "../lib/notification-outbox": `
            export const enqueueUserNotification=async(conn,userId,key,content)=>{
              if(!conn.inTransaction)throw new Error("notification was not enqueued in the status transaction");
              const current=globalThis.__smmOrderTestNotifications.get(key);
              if(!current)globalThis.__smmOrderTestNotifications.set(key,{userId,content,status:"pending",payload_encrypted:"ciphertext"});
            };`,
        };
        return { contents: stubs[args.path], loader: "js" };
      });
    },
  }],
});
const { syncOrderInternal } = await import(pathToFileURL(outfile).href);

function testDb() {
  const order = {
    id: "order-123", user_id: "user-1", provider: 1, service_id: "42",
    service_name: "Abonnés Instagram", quantity: 100, charge_minor: 1000,
    revenue_fcfa_minor: 1000, currency: "XOF", provider_order_id: "provider-456",
    external_order_id: "provider-456", status: "processing",
  };
  const notifications = new Map();
  const outboxTransactions = [];
  const db = {
    order, notifications, outboxTransactions,
    async execute(sql) {
      if (sql.startsWith("SELECT * FROM orders")) return [[{ ...order }]];
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    async getConnection() {
      return {
        inTransaction: false,
        async beginTransaction() { this.inTransaction = true; },
        async execute(sql, args) {
          if (sql.startsWith("SELECT * FROM orders")) return [[{ ...order }]];
          if (sql.startsWith("SELECT balance_minor FROM profiles")) return [[{ balance_minor: 5000 }]];
          if (sql.startsWith("UPDATE orders SET status=")) {
            order.status = args[0];
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith("UPDATE orders SET refunded_at")) {
            order.refunded_at = args[0];
            order.refunded_amount_minor = args[1];
            return [{ affectedRows: 1 }];
          }
          if (sql.includes("UPDATE notification_outbox")) {
            outboxTransactions.push(this.inTransaction);
            const event = notifications.get(args[0]);
            if (event?.status === "pending") {
              Object.assign(event, { status: "expired", payload_encrypted: null, lock_token: null, locked_until: null });
            }
            return [{ affectedRows: event?.status === "expired" ? 1 : 0 }];
          }
          if (sql.startsWith("UPDATE profiles") || sql.startsWith("INSERT INTO wallet_transactions") ||
              sql.startsWith("INSERT INTO balance_audit_log")) return [{ affectedRows: 1 }];
          throw new Error(`Unexpected transaction query: ${sql}`);
        },
        async commit() { this.inTransaction = false; },
        async rollback() { this.inTransaction = false; },
        release() {},
      };
    },
  };
  globalThis.__smmOrderTestDb = db;
  globalThis.__smmOrderTestNotifications = notifications;
  return db;
}

test("completion notification is queued once with French transaction details", async t => {
  const db = testDb();
  t.after(() => {
    delete globalThis.__smmOrderTestDb;
    delete globalThis.__smmOrderTestNotifications;
  });

  const first = await syncOrderInternal({ localOrderId: db.order.id });
  const repeated = await syncOrderInternal({ localOrderId: db.order.id });

  assert.equal(first.status, "completed");
  assert.equal(first.previous_status, "processing");
  assert.equal(repeated.previous_status, "completed");
  assert.equal(db.order.status, "completed");
  assert.equal(db.notifications.size, 1);
  assert.deepEqual(db.notifications.get("smm-order-completed-order-123"), {
    userId: "user-1",
    content: {
      subject: "Votre commande SMM est terminée",
      title: "Commande terminée",
      message: "Votre commande a été réalisée avec succès.",
      category: "transactionnel",
      details: {
        Service: "Abonnés Instagram",
        "Référence de commande": "provider-456",
      },
    },
    status: "pending",
    payload_encrypted: "ciphertext",
  });
});

test("a refund after completion expires the pending notification in the refund transaction", async t => {
  const db = testDb();
  t.after(() => {
    delete globalThis.__smmOrderTestDb;
    delete globalThis.__smmOrderTestNotifications;
  });

  await syncOrderInternal({ localOrderId: db.order.id });
  const key = "smm-order-completed-order-123";
  assert.equal(db.notifications.get(key).status, "pending");

  const refunded = await syncOrderInternal({ localOrderId: db.order.id, forceRefund: true });
  assert.equal(refunded.status, "refunded");
  assert.equal(db.order.status, "refunded");
  assert.equal(db.notifications.get(key).status, "expired");
  assert.equal(db.notifications.get(key).payload_encrypted, null);
  assert.deepEqual(db.outboxTransactions, [true]);

  await syncOrderInternal({ localOrderId: db.order.id, forceRefund: true });
  assert.equal(db.notifications.get(key).status, "expired");
  assert.deepEqual(db.outboxTransactions, [true]);
});

test("refund before completion prevents a later completion sync from queuing email", async t => {
  const db = testDb();
  t.after(() => {
    delete globalThis.__smmOrderTestDb;
    delete globalThis.__smmOrderTestNotifications;
  });

  await syncOrderInternal({ localOrderId: db.order.id, forceRefund: true });
  assert.ok(db.order.refunded_at);
  const completed = await syncOrderInternal({ localOrderId: db.order.id });
  const repeated = await syncOrderInternal({ localOrderId: db.order.id });

  assert.equal(completed.status, "refunded");
  assert.equal(repeated.previous_status, "refunded");
  assert.equal(db.notifications.size, 0);
  assert.equal(db.order.status, "refunded");
});

for (const state of ["sending", "sent"]) {
  test(`refund does not invalidate an already-${state} completion event`, async t => {
    const db = testDb();
    t.after(() => {
      delete globalThis.__smmOrderTestDb;
      delete globalThis.__smmOrderTestNotifications;
    });

    await syncOrderInternal({ localOrderId: db.order.id });
    const key = "smm-order-completed-order-123";
    const event = db.notifications.get(key);
    event.status = state;
    const payload = event.payload_encrypted;
    await syncOrderInternal({ localOrderId: db.order.id, forceRefund: true });

    assert.equal(event.status, state);
    assert.equal(event.payload_encrypted, payload);
    assert.deepEqual(db.outboxTransactions, [true]);
  });
}