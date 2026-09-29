import assert from "node:assert/strict";
import { test, after } from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const dir = await mkdtemp(fileURLToPath(new URL("../node_modules/signup-verification-test-", import.meta.url)));
after(() => rm(dir, { recursive: true, force: true }));

const state = { row: null, queued: [], outboxRows: [], verified: false, sessionsRevoked: false };
globalThis.__signupVerificationTest = state;
delete process.env.SESSION_SECRET;
process.env.MAILTRAP_API_TOKEN = "test-provider-secret";
process.env.MAILTRAP_FROM_EMAIL = "sender@verified.example";
const outfile = path.join(dir, "signup-verification.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/signup-verification.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
  plugins: [{
    name: "mock-notification-outbox",
    setup(build) {
      build.onResolve({ filter: /^\.\/notification-outbox$/ }, () => ({ path: "notification-outbox", namespace: "mock" }));
      build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
        contents: `export const enqueueUserNotification = async (_conn,id,key,content) => {
          const test = globalThis.__signupVerificationTest;
          test.queued.push({id,key,content});
          test.outboxRows.push({event_key:key,status:"pending"});
        };`,
        loader: "js",
      }));
    },
  }],
});
const { ensureSignupVerification, queueSignupVerification, resendSignupVerification, verifySignupEmail } = await import(pathToFileURL(outfile).href);

function reset() {
  state.row = null;
  state.queued = [];
  state.outboxRows = [];
  state.verified = false;
  state.sessionsRevoked = false;
}

const conn = {
  async execute(sql, args = []) {
    if (sql.includes("SELECT user_id FROM signup_email_verifications")) {
      return [state.row && state.row.user_id === args[0] ? [{ user_id: state.row.user_id }] : []];
    }
    if (sql.includes("UPDATE notification_outbox SET status='expired'")) {
      const prefix = args[0].slice(0, -1);
      for (const message of state.outboxRows) {
        if (message.status === "pending" && message.event_key.startsWith(prefix)) message.status = "expired";
      }
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("INSERT INTO signup_email_verifications")) {
      state.row = {
        user_id: args[0], code_hash: args[1], expires_at: args[2], attempts: 0,
        sent_at: Date.now(), hour_window_started_at: Date.now(), sends_in_window: 1, consumed_at: null,
      };
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SELECT sent_at >")) {
      return [[{
        in_cooldown: Number(Date.now() - state.row.sent_at < 60_000),
        in_hour_window: Number(Date.now() - state.row.hour_window_started_at < 3_600_000),
        sends_in_window: state.row.sends_in_window,
      }]];
    }
    if (sql.includes("UPDATE signup_email_verifications SET code_hash")) {
      Object.assign(state.row, {
        code_hash: args[0], expires_at: args[1], attempts: 0, sent_at: Date.now(),
        hour_window_started_at: args[2] ? state.row.hour_window_started_at : Date.now(),
        sends_in_window: args[3] ? state.row.sends_in_window + 1 : 1, consumed_at: null,
      });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SELECT code_hash")) {
      return [[state.row ? {
        code_hash: state.row.code_hash, attempts: state.row.attempts, consumed_at: state.row.consumed_at,
        not_expired: Number(new Date(state.row.expires_at).getTime() > Date.now()),
      } : undefined].filter(Boolean)];
    }
    if (sql.includes("SET attempts=attempts+1")) {
      state.row.attempts++;
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SET email_verified_at")) {
      state.verified = true;
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SET consumed_at=NOW(3), code_hash=NULL")) {
      state.row.consumed_at = new Date();
      state.row.code_hash = null;
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SET consumed_at=NOW(3)")) {
      state.row.consumed_at = new Date();
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("UPDATE auth_sessions")) {
      state.sessionsRevoked = true;
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected query: ${sql}`);
  },
};

test("OTP is six digits; database stores provider-secret HMAC without requiring SESSION_SECRET", async () => {
  reset();
  await queueSignupVerification(conn, "user-1");
  const payload = state.queued[0].content;
  assert.match(payload.otp_code, /^\d{6}$/);
  assert.ok(payload.message.includes(payload.otp_code), "visible email message includes OTP digits");
  assert.notEqual(state.row.code_hash, payload.otp_code);
  assert.match(state.row.code_hash, /^[a-f0-9]{64}$/);
  assert.equal(payload.category, "security");
  assert.equal(state.queued.length, 1);
  assert.ok(state.queued[0].key.startsWith("signup-verification-user-1-"));
  assert.ok(state.queued[0].key.length < 192);
});

test("legacy unverified account gets its first code on login or resend, but no duplicate on login", async () => {
  reset();
  await ensureSignupVerification(conn, "legacy-user");
  assert.equal(state.queued.length, 1);
  await ensureSignupVerification(conn, "legacy-user");
  await resendSignupVerification(conn, "legacy-user");
  assert.equal(state.queued.length, 1, "existing code is kept during cooldown");
  state.row.sent_at = Date.now() - 61_000;
  await resendSignupVerification(conn, "legacy-user");
  assert.equal(state.queued.length, 2);
  assert.equal(await verifySignupEmail(conn, "legacy-user", state.queued.at(-1).content.otp_code), true);

  reset();
  await resendSignupVerification(conn, "legacy-user");
  assert.equal(state.queued.length, 1, "resend initializes a legacy user without an OTP record");
});

test("wrong attempts, expiry, one-use consumption, verification and session revocation", async () => {
  reset();
  await queueSignupVerification(conn, "user-1");
  const code = state.queued[0].content.otp_code;
  assert.equal(await verifySignupEmail(conn, "user-1", code === "000000" ? "000001" : "000000"), false);
  assert.equal(state.row.attempts, 1);
  assert.equal(await verifySignupEmail(conn, "user-1", code), true);
  assert.equal(state.verified, true);
  assert.equal(state.sessionsRevoked, true);
  assert.equal(state.row.code_hash, null);
  assert.equal(await verifySignupEmail(conn, "user-1", code), false);

  reset();
  await queueSignupVerification(conn, "user-2");
  state.row.expires_at = new Date(0);
  assert.equal(await verifySignupEmail(conn, "user-2", state.queued[0].content.otp_code), false);
  assert.ok(state.row.consumed_at);

  reset();
  await queueSignupVerification(conn, "user-3");
  const validCode = state.queued[0].content.otp_code;
  const wrongCode = validCode === "999999" ? "000000" : "999999";
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(await verifySignupEmail(conn, "user-3", wrongCode), false);
  }
  assert.equal(state.row.attempts, 5);
  assert.equal(await verifySignupEmail(conn, "user-3", validCode), false);
  assert.equal(state.verified, false);
});

test("resend observes persistent cooldown, enforces hourly limit and replaces the active hash", async () => {
  reset();
  await queueSignupVerification(conn, "user-3");
  const originalHash = state.row.code_hash;
  const originalMessage = state.queued[0];
  state.outboxRows.push(
    { event_key: "signup-verification-user-3-sending", status: "sending" },
    { event_key: "signup-verification-user-3-sent", status: "sent" },
  );
  await resendSignupVerification(conn, "user-3");
  assert.equal(state.queued.length, 1, "immediate resend is blocked");

  state.row.sent_at = Date.now() - 61_000;
  for (let count = 0; count < 4; count++) {
    await resendSignupVerification(conn, "user-3");
    state.row.sent_at = Date.now() - 61_000;
  }
  assert.equal(state.queued.length, 5, "initial send plus four resends reach five/hour");
  assert.equal(state.outboxRows.find(row => row.event_key === originalMessage.key).status, "expired");
  assert.equal(state.outboxRows.find(row => row.status === "sending").status, "sending");
  assert.equal(state.outboxRows.find(row => row.status === "sent").status, "sent");
  const latestCode = state.queued.at(-1).content.otp_code;
  assert.notEqual(state.row.code_hash, originalHash);
  assert.equal(await verifySignupEmail(conn, "user-3", state.queued[0].content.otp_code), false);
  assert.equal(await verifySignupEmail(conn, "user-3", latestCode), true);
  state.row.sent_at = Date.now() - 61_000;
  await resendSignupVerification(conn, "user-3");
  assert.equal(state.queued.length, 5, "hourly cap persists");
});