import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const outfile = fileURLToPath(new URL("../dist/notification-outbox-test.mjs", import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/notification-outbox.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent",
  loader: { ".png": "dataurl" },
  plugins: [{
    name: "no-live-db-or-logger",
    setup(b) {
      b.onResolve({ filter: /^\.\/(mysql|logger)$/ }, args => ({
        path: args.path, namespace: "outbox-stub",
      }));
      b.onLoad({ filter: /.*/, namespace: "outbox-stub" }, args => ({
        contents: args.path === "./mysql"
          ? "export const getMysqlPool = () => globalThis.__outboxDb;"
          : "export const logger = { info() {}, warn() {}, error() {} };",
        loader: "js",
      }));
    },
  }],
});
const outbox = await import(pathToFileURL(outfile).href);
process.env.MAILTRAP_API_TOKEN = "local-test-token";
process.env.MAILTRAP_FROM_EMAIL = "sender@verified.example";

function database() {
  const rows = new Map();
  const calls = [];
  let now = Date.now();
  const runnable = row => (row.status === "pending" && row.available_at <= now ||
    row.status === "sending" && row.locked_until < now) &&
    (row.expires_at === null || row.expires_at > now);
  const db = {
    rows, calls,
    advance(ms) { now += ms; },
    async execute(sql, args = []) {
      calls.push({ sql, args });
      if (sql.includes("SELECT u.email, p.username")) return [[
        { email: "owned@example.test", username: "Real Profile" },
      ]];
      if (sql.includes("INSERT INTO notification_outbox")) {
        const [key, encrypted, expires] = args;
        if (!rows.has(key)) rows.set(key, {
          event_key: key, payload_encrypted: encrypted, expires_at: expires?.getTime() ?? null,
          status: "pending", attempts: 0, available_at: now, lock_token: null, locked_until: null,
        });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("SET status='expired'")) {
        for (const row of rows.values()) {
          if (["pending", "sending"].includes(row.status) && row.expires_at !== null &&
              row.expires_at <= now && (row.locked_until === null || row.locked_until < now)) {
            Object.assign(row, { status: "expired", payload_encrypted: null,
              lock_token: null, locked_until: null, finished_at: now });
          }
        }
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("SELECT event_key FROM notification_outbox")) {
        return [[...rows.values()].filter(runnable).sort((a, b) => a.available_at - b.available_at)
          .slice(0, 1).map(({ event_key }) => ({ event_key }))];
      }
      if (sql.includes("SET status='sending'")) {
        const [token, key] = args;
        const row = rows.get(key);
        if (!row || !runnable(row)) return [{ affectedRows: 0 }];
        Object.assign(row, { status: "sending", lock_token: token, locked_until: now + 90_000,
          attempts: row.attempts + 1 });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("SELECT payload_encrypted,attempts,expires_at")) {
        const [key, token] = args;
        const row = rows.get(key);
        return [row?.lock_token === token ? [row] : []];
      }
      if (sql.includes("SET status='sent'")) {
        const [deliveryId, key, token] = args;
        const row = rows.get(key);
        if (row?.lock_token !== token) return [{ affectedRows: 0 }];
        Object.assign(row, { status: "sent", payload_encrypted: null, delivery_id: deliveryId,
          lock_token: null, locked_until: null, finished_at: now, last_http_status: null });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("SET status=?")) {
        const [status, delay, retry, httpStatus, , key, token] = args;
        const row = rows.get(key);
        if (row?.lock_token !== token) return [{ affectedRows: 0 }];
        Object.assign(row, { status, available_at: now + delay * 1000,
          payload_encrypted: retry ? row.payload_encrypted : null, lock_token: null,
          locked_until: null, last_http_status: httpStatus, finished_at: retry ? null : now });
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  globalThis.__outboxDb = db;
  return db;
}

const content = {
  subject: "Payment confirmed", title: "Deposit", message: "Credited",
  recipient_email: "injected@attacker.test", recipient_name: "Injected",
};
const json = (status, body) => new Response(JSON.stringify(body), { status });
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; delete globalThis.__outboxDb; });

test("enqueue derives encrypted recipients from own user/profile and freezes first event", async () => {
  const db = database();
  await outbox.enqueueUserNotification(db, "user-1", "payment-confirmed-1", content);
  const row = db.rows.get("payment-confirmed-1");
  assert.ok(row.payload_encrypted);
  assert.doesNotMatch(row.payload_encrypted, /owned@example|injected|Credited/);
  assert.deepEqual(outbox.decryptNotification(row.payload_encrypted), {
    ...content, recipient_email: "owned@example.test", recipient_name: "Real Profile",
  });
  const first = row.payload_encrypted;
  await outbox.enqueueUserNotification(db, "user-1", "payment-confirmed-1", {
    ...content, message: "Changed", recipient_email: "elsewhere@attacker.test",
  });
  assert.equal(row.payload_encrypted, first);
  assert.equal(db.calls.filter(c => c.sql.includes("SELECT u.email")).length, 2);
  await assert.rejects(outbox.enqueueUserNotification(db, "user-1", "bad key", content), /Invalid notification event key/);
});

test("dispatch sends frozen content to Mailtrap, erases ciphertext and stores message ID", async () => {
  const db = database();
  await outbox.enqueueUserNotification(db, "user-1", "payment-confirmed-2", content);
  const expected = outbox.decryptNotification(db.rows.get("payment-confirmed-2").payload_encrypted);
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(init);
    return json(200, { success: true, message_ids: ["delivery-2"] });
  };
  await outbox.dispatchNotifications();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers["Idempotency-Key"], undefined);
  assert.equal(sent[0].headers["Api-Token"], "local-test-token");
  assert.deepEqual(JSON.parse(sent[0].body).to, [{ email: expected.recipient_email, name: expected.recipient_name }]);
  assert.match(JSON.parse(sent[0].body).text, /Credited/);
  assert.equal(db.rows.get("payment-confirmed-2").status, "sent");
  assert.equal(db.rows.get("payment-confirmed-2").payload_encrypted, null);
  assert.equal(db.rows.get("payment-confirmed-2").delivery_id, "delivery-2");
  assert.equal(db.rows.get("payment-confirmed-2").attempts, 1);
});

test("database failure after provider ACK keeps lease recoverable; retry may deliver twice", async () => {
  const db = database();
  const key = "payment-confirmed-db-outage";
  await outbox.enqueueUserNotification(db, "user-1", key, content);
  const row = db.rows.get(key);
  const encrypted = row.payload_encrypted;
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push({ body: init.body });
    return json(200, { success: true, message_ids: [sent.length === 1 ? "first-ack" : "second-ack"] });
  };
  const execute = db.execute.bind(db);
  let outage = true;
  db.execute = async (sql, args) => {
    if (outage && sql.includes("SET status='sent'")) {
      outage = false;
      throw new Error("simulated database outage after provider acceptance");
    }
    return execute(sql, args);
  };
  await assert.rejects(outbox.dispatchNotifications(), /simulated database outage/);
  assert.equal(sent.length, 1);
  assert.equal(row.status, "sending");
  assert.equal(row.attempts, 1);
  assert.equal(row.payload_encrypted, encrypted);
  assert.ok(row.lock_token);
  assert.equal(db.calls.some(c => c.sql.includes("SET status=?")), false);
  await outbox.dispatchNotifications();
  assert.equal(sent.length, 1, "a live lease must prevent immediate re-delivery");
  db.advance(90_001);
  await outbox.dispatchNotifications();
  assert.deepEqual(sent, [sent[0], sent[0]]);
  assert.equal(row.attempts, 2);
  assert.equal(row.status, "sent");
  assert.equal(row.delivery_id, "second-ack");
  assert.equal(row.payload_encrypted, null);
  assert.equal(row.lock_token, null);
});

test("network error and 503 retry across dispatches with identical bytes/key and exponential delay", async () => {
  const db = database();
  await outbox.enqueueUserNotification(db, "user-1", "payment-confirmed-3", content);
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push({ body: init.body });
    if (sent.length === 1) throw new Error("network down");
    return sent.length === 2 ? json(503, { error: "unavailable" }) :
      json(200, { success: true, message_ids: ["accepted"] });
  };
  await outbox.dispatchNotifications();
  const row = db.rows.get("payment-confirmed-3");
  assert.equal(row.status, "pending");
  assert.equal(row.last_http_status, null);
  assert.equal(row.attempts, 1);
  await outbox.dispatchNotifications();
  assert.equal(sent.length, 1);
  db.advance(5_000);
  await outbox.dispatchNotifications();
  assert.equal(row.attempts, 2);
  assert.equal(row.status, "pending");
  assert.equal(row.last_http_status, 503);
  db.advance(9_999);
  await outbox.dispatchNotifications();
  assert.equal(sent.length, 2);
  db.advance(1);
  await outbox.dispatchNotifications();
  assert.equal(row.status, "sent");
  assert.equal(row.attempts, 3);
  assert.deepEqual(sent, [sent[0], sent[0], sent[0]]);
});

for (const status of [401, 409, 422]) {
  test(`${status} permanently fails and erases encrypted payload`, async () => {
    const db = database();
    await outbox.enqueueUserNotification(db, "user-1", `payment-${status}`, content);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return json(status, { error: "rejected" }); };
    await outbox.dispatchNotifications();
    const row = db.rows.get(`payment-${status}`);
    assert.equal(row.status, "failed");
    assert.equal(row.attempts, 1);
    assert.equal(row.last_http_status, status);
    assert.equal(row.payload_encrypted, null);
    db.advance(300_000);
    await outbox.dispatchNotifications();
    assert.equal(calls, 1);
  });
}

test("CAS lease prevents concurrent claims; expired lease is recoverable and stale completion cannot overwrite", async () => {
  const db = database();
  await outbox.enqueueUserNotification(db, "user-1", "lease-1", content);
  let release;
  const first = new Promise(resolve => { release = resolve; });
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? first :
    json(200, { success: true, message_ids: ["recovered"] });
  const firstRun = outbox.dispatchNotifications();
  // Wait for the first HTTP call without waiting for its unresolved response.
  while (!calls) await new Promise(resolve => setImmediate(resolve));
  await outbox.dispatchNotifications();
  assert.equal(calls, 1);
  db.advance(90_001);
  await outbox.dispatchNotifications();
  assert.equal(calls, 2);
  assert.equal(db.rows.get("lease-1").delivery_id, "recovered");
  assert.equal(db.rows.get("lease-1").attempts, 2);
  release(json(200, { success: true, message_ids: ["stale"] }));
  await firstRun;
  assert.equal(db.rows.get("lease-1").delivery_id, "recovered");
  assert.ok(db.calls.some(c => c.sql.includes("SET status='sent'") && c.args[0] === "stale"));
});

test("expired pending and expired abandoned leases are erased without sending", async () => {
  const db = database();
  await outbox.enqueueUserNotification(db, "user-1", "expiry-1", {
    ...content, expires_at: new Date(Date.now() + 1000).toISOString(),
  });
  db.advance(2000);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json(200, { success: true, message_ids: ["unexpected"] }); };
  await outbox.dispatchNotifications();
  const row = db.rows.get("expiry-1");
  assert.equal(row.status, "expired");
  assert.equal(row.payload_encrypted, null);
  assert.equal(calls, 0);
  await outbox.enqueueUserNotification(db, "user-1", "expiry-2", {
    ...content, expires_at: new Date(Date.now() + 1000).toISOString(),
  });
  const abandoned = db.rows.get("expiry-2");
  Object.assign(abandoned, { status: "sending", lock_token: "abandoned", locked_until: 0 });
  await outbox.dispatchNotifications();
  assert.equal(abandoned.status, "expired");
  assert.equal(abandoned.payload_encrypted, null);
});

test("eight failures exhaust retries and erase payload", async () => {
  const db = database();
  await outbox.enqueueUserNotification(db, "user-1", "exhausted-1", content);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json(503, {}); };
  const row = db.rows.get("exhausted-1");
  for (let attempt = 1; attempt <= 8; attempt++) {
    await outbox.dispatchNotifications();
    assert.equal(row.attempts, attempt);
    assert.equal(row.status, attempt === 8 ? "failed" : "pending");
    if (attempt < 8) {
      assert.ok(row.payload_encrypted);
      db.advance(outbox.retryDelaySeconds(attempt) * 1000);
    }
  }
  assert.equal(row.payload_encrypted, null);
  db.advance(1000_000);
  await outbox.dispatchNotifications();
  assert.equal(calls, 8);
});