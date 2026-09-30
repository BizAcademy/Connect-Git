import assert from "node:assert/strict";
import { test, after } from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import express from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

const dir = await mkdtemp(fileURLToPath(new URL("../node_modules/password-reset-test-", import.meta.url)));
after(() => rm(dir, { recursive: true, force: true }));
let enabled = true;
let clock = new Date("2026-01-01T00:00:00Z");
let users = new Map();
let profiles = new Map();
let tokens = new Map();
let limits = new Map();
let sessions = new Set();
let queued = [];
let queries = [];
let transactionEvents = [];
let verificationCodes = new Map();
const userId = crypto.randomUUID();

function reset() {
  clock = new Date("2026-01-01T00:00:00Z");
  users = new Map([["someone@example.com", { id: userId, email: "someone@example.com", password_hash: "old", email_verified_at: new Date() }]]);
  profiles = new Map();
  tokens = new Map(); limits = new Map(); sessions = new Set([userId]); queued = []; queries = []; transactionEvents = [];
  verificationCodes = new Map();
  if (globalThis.__resetTest) {
    globalThis.__resetTest.users = users;
    globalThis.__resetTest.verificationCodes = verificationCodes;
    globalThis.__resetTest.queued = queued;
  }
  enabled = true;
}
reset();
globalThis.__resetTest = {
  pool: {
    execute: async (sql, args = []) => {
      const connection = await globalThis.__resetTest.pool.getConnection();
      return connection.execute(sql, args);
    },
    getConnection: async () => {
      const connectionId = crypto.randomUUID();
      return {
      beginTransaction: async () => { transactionEvents.push(["begin", connectionId]); },
      commit: async () => { transactionEvents.push(["commit", connectionId]); },
      rollback: async () => { transactionEvents.push(["rollback", connectionId]); },
      release: () => {},
      execute: async (sql, args = []) => {
        queries.push([sql, args, connectionId]);
        if (sql.includes("INSERT IGNORE INTO password_reset_throttles")) {
          if (!limits.has(args[0])) limits.set(args[0], 0);
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("FROM password_reset_throttles")) return [[...limits.entries()]
          .filter(([key]) => args.includes(key))
          .map(([throttle_key, until]) => ({ throttle_key, blocked: Number(until > clock.getTime()) }))];
        if (sql.includes("UPDATE password_reset_throttles")) {
          limits.set(args[1], clock.getTime() + args[0] / 1000);
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("UPDATE password_reset_tokens SET used_at=NOW(3) WHERE user_id=? AND reset_type='otp'")) {
          for (const token of tokens.values()) {
            if (token.user_id === args[0] && token.reset_type === "otp" && token.used_at === null) token.used_at = clock;
          }
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("UPDATE notification_outbox")) return [{ affectedRows: 1 }];
        if (sql.includes("INSERT INTO users")) {
          users.set(args[1], { id: args[0], email: args[1], password_hash: args[2], email_verified_at: null });
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("INSERT INTO profiles")) {
          profiles.set(args[0], { user_id: args[0], email: args[1], username: args[2], country: args[3] });
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("FROM users u LEFT JOIN profiles p")) {
          const user = users.get(args[0]);
          return [user ? [{ ...profiles.get(user.id), ...user, is_admin: user.is_admin ? 1 : 0 }] : []];
        }
        if (sql.includes("FROM users WHERE email")) {
          const user = users.get(args[0]);
          return [user ? [{ id: user.id, email_verified_at: user.email_verified_at }] : []];
        }
        if (sql.includes("INSERT INTO password_reset_tokens")) {
          tokens.set(args[2], {
            id: args[0], user_id: args[1], token_hash: args[2], expires_at: args[3], used_at: null, attempts: 0,
            reset_type: args[4] || "otp",
          });
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("FROM password_reset_tokens") && sql.includes("reset_type='otp'")) {
          const token = [...tokens.values()].filter(row =>
            row.user_id === args[0] && row.reset_type === "otp" && row.used_at === null)
            .sort((a, b) => new Date(b.created_at || b.expires_at) - new Date(a.created_at || a.expires_at))[0];
          return [token ? [{ ...token }] : []];
        }
        if (sql.includes("SET attempts=attempts+1")) {
          const token = [...tokens.values()].find(row => row.id === args[0]);
          if (token && token.attempts < args[1]) token.attempts++;
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("FROM password_reset_tokens WHERE token_hash")) {
          const token = tokens.get(args[0]);
          return [token?.reset_type === "legacy" ? [{ ...token }] : []];
        }
        if (sql.includes("FROM users WHERE email")) {
          const user = users.get(args[0]);
          return [user ? [{ id: user.id, email_verified_at: user.email_verified_at }] : []];
        }
        if (sql.includes("FROM users WHERE id")) return [[...users.values()]
          .filter(user => user.id === args[0] && (!sql.includes("email_verified_at IS NULL") || !user.email_verified_at))
          .map(user => ({ id: user.id }))];
        if (sql.includes("UPDATE users SET password_hash")) {
          [...users.values()].find(user => user.id === args[1]).password_hash = args[0];
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("UPDATE password_reset_tokens SET used_at")) {
          for (const token of tokens.values()) if (token.user_id === args[0]) token.used_at = clock;
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("UPDATE auth_sessions SET revoked_at")) {
          sessions.delete(args[0]); return [{ affectedRows: 1 }];
        }
        if (sql.includes("INSERT INTO user_roles") || sql.includes("INSERT INTO auth_sessions")) return [{ affectedRows: 1 }];
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    },
  },
      enabled: () => enabled,
  users,
  verificationCodes,
  queued,
  enqueue: async (_conn, id, key, content) => { queued.push({ id, key, content }); },
};
const outfile = path.join(dir, "auth.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/routes/auth.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
  plugins: [{
    name: "mock-auth-dependencies",
    setup(build) {
      build.onResolve({ filter: /^\.\.\/lib\/(mysql|auth|referrals|notification-outbox|signup-verification)$/ }, ({ path }) => ({ path, namespace: "mock" }));
      build.onResolve({ filter: /^\.\/(notification-outbox|mailtrap-notification-client)$/ }, ({ path }) => ({ path, namespace: "mock" }));
      build.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({
        contents: path.endsWith("/mysql") ? "export const getMysqlPool = () => globalThis.__resetTest.pool;" :
          path.endsWith("/auth") ? "export const requireUser = (_req,_res,next) => next();" :
          path.endsWith("/referrals") ? "export const normalizeCode = x => x;" :
          path.endsWith("/mailtrap-notification-client") ? "export const validateMailtrapConfig = () => ({ apiToken: 'test-trusted-server-secret', fromEmail: 'test@example.com', fromName: 'Tests' });" :
          path.endsWith("/signup-verification") ? `
            export async function queueSignupVerification(_conn, id) {
              globalThis.__resetTest.verificationCodes.set(id, { code: "123456", attempts: 0, expires: Date.now() + 600000, sentAt: Date.now(), sends: 1 });
              globalThis.__resetTest.queued.push({ id, key: "signup-verification-" + id + "-initial", content: { otp_code: "123456", message: "Saisissez le code 123456 pour vérifier votre adresse.", category: "security" } });
            }
            export async function ensureSignupVerification(conn, id) {
              const state = globalThis.__resetTest.verificationCodes.get(id);
              if (!state) return queueSignupVerification(conn, id);
              if (state.expires <= Date.now() || state.attempts >= 5) return resendSignupVerification(conn, id);
            }
            export async function verifySignupEmail(_conn, id, code) {
              const state = globalThis.__resetTest.verificationCodes.get(id);
              if (!state || Date.now() >= state.expires || state.attempts >= 5 || state.code !== code) {
                if (state && state.attempts < 5) state.attempts++;
                return false;
              }
              const user = [...globalThis.__resetTest.users.values()].find(u => u.id === id);
              user.email_verified_at = new Date();
              globalThis.__resetTest.verificationCodes.delete(id);
              return true;
            }
            export async function resendSignupVerification(_conn, id) {
              const state = globalThis.__resetTest.verificationCodes.get(id);
              const now = Date.now();
              if (!state) return queueSignupVerification(_conn, id);
              if ((state.sentAt && now - state.sentAt < 60000) || (state.sentAt && state.sends >= 5)) return;
              globalThis.__resetTest.verificationCodes.set(id, { code: "654321", attempts: 0, expires: now + 600000, sentAt: now, sends: (state.sends || 1) + 1 });
              globalThis.__resetTest.queued.push({ id, key: "signup-verification-" + id + "-resend-" + now, content: { otp_code: "654321", message: "Saisissez le code 654321 pour vérifier votre adresse.", category: "security" } });
            }` :
          `export const notificationsEnabled = () => globalThis.__resetTest.enabled();
           export const notificationAction = p => globalThis.__resetTest.action(p);
           export const enqueueUserNotification = (...a) => globalThis.__resetTest.enqueue(...a);`,
        loader: "js",
      }));
    },
  }],
});
const { default: router } = await import(pathToFileURL(outfile).href);
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.log = { error: () => {} };
  if (req.get("x-test-ip")) Object.defineProperty(req, "ip", { value: req.get("x-test-ip") });
  next();
});
app.use("/api", router);
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
after(() => new Promise(resolve => server.close(resolve)));
let requestIp = 1;
async function post(endpoint, body, ip) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json", "x-test-ip": ip || `198.51.100.${requestIp++}`, ...(ip ? { "x-test-ip": ip } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), setCookie: response.headers.get("set-cookie") };
}

test("unknown and known requests have identical responses; known account queues only a hashed OTP", async () => {
  reset();
  const unknown = await post("forgot-password", { email: "missing@example.com" });
  clock = new Date(clock.getTime() + 61_000);
  const known = await post("forgot-password", { email: "someone@example.com" });
  assert.deepEqual(known, unknown);
  assert.equal(queued.length, 1);
  assert.match(queued[0].key, /^password-reset-/);
  const code = queued[0].content.otp_code;
  assert.match(code, /^\d{6}$/);
  assert.equal(queued[0].content.action_url, undefined);
  assert.ok(new Date(queued[0].content.expires_at).getTime() - Date.now() <= 10 * 60_000);
  const digest = crypto.createHmac("sha256", "test-trusted-server-secret")
    .update("bizpanel-password-reset-otp-v1\0").update(userId).update("\0").update(code).digest("hex");
  assert.ok(tokens.has(digest));
  assert.ok(!queries.some(([sql, args]) => sql.includes("password_reset_tokens") && args.includes(code)));
});

test("distributed IPs cannot flood one account; same IP cannot flood different accounts", async () => {
  reset();
  users.set("other@example.com", { id: crypto.randomUUID(), password_hash: "old" });
  await post("forgot-password", { email: "someone@example.com" }, "192.0.2.1");
  await post("forgot-password", { email: "someone@example.com" }, "192.0.2.2");
  assert.equal(queued.length, 1);
  await post("forgot-password", { email: "other@example.com" }, "192.0.2.1");
  assert.equal(queued.length, 1);
  clock = new Date(clock.getTime() + 61_000);
  await post("forgot-password", { email: "someone@example.com" }, "192.0.2.3");
  assert.equal(queued.length, 1);
  clock = new Date(clock.getTime() + 5 * 60_000);
  await post("forgot-password", { email: "someone@example.com" }, "192.0.2.3");
  assert.equal(queued.length, 2);
});

test("missing delivery configuration fails closed without account enumeration", async () => {
  reset();
  enabled = false;
  const unknown = await post("forgot-password", { email: "missing@example.com" });
  const known = await post("forgot-password", { email: "someone@example.com" });
  assert.deepEqual(unknown, known);
  assert.equal(known.status, 503);
  assert.equal(queued.length, 0);
});

test("registration creates an unverified account and queues one OTP event without a session", async () => {
  reset();
  const result = await post("register", {
    email: "fresh@example.com", password: "signup-password", username: "newmember", country: "CI",
  });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { verificationRequired: true, email: "fresh@example.com" });
  assert.equal(result.body.user, undefined);
  assert.equal(result.setCookie, null);
  assert.equal(queued.length, 1);
  assert.match(queued[0].key, /^signup-verification-/);
  assert.match(queued[0].content.otp_code, /^\d{6}$/);
  assert.ok(queued[0].content.message.includes(queued[0].content.otp_code));
  assert.equal(queued[0].content.category, "security");
  assert.equal([...users.values()].find(user => user.email === "fresh@example.com").email_verified_at, null);
  reset();
  enabled = false;
  const unavailable = await post("register", {
    email: "fresh@example.com", password: "signup-password", username: "newmember", country: "CI",
  });
  assert.equal(unavailable.status, 503);
  assert.equal(queued.length, 0);
});

test("register -> denied login -> verify -> login; verification code cannot replay", async () => {
  reset();
  await post("register", {
    email: "fresh@example.com", password: "signup-password", username: "newmember", country: "CI",
  });
  const denied = await post("login", { email: "fresh@example.com", password: "signup-password" });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "EMAIL_VERIFICATION_REQUIRED");
  assert.equal(denied.body.error.length > 0, true);
  assert.equal(queries.some(([sql]) => sql.includes("INSERT INTO auth_sessions")), false);

  const verified = await post("verify-email", { email: "fresh@example.com", code: "123456" });
  assert.equal(verified.status, 200);
  assert.match(verified.body.message, /vérifiée/i);
  assert.equal((await post("verify-email", { email: "fresh@example.com", code: "123456" })).status, 400);
  const login = await post("login", { email: "fresh@example.com", password: "signup-password" });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.email, "fresh@example.com");
  assert.equal(queries.some(([sql]) => sql.includes("INSERT INTO auth_sessions")), true);
});

test("login verifies under the user lock and commits rehash plus session on the same transaction", async () => {
  reset();
  const verifiedHash = await bcrypt.hash("old-password", 10);
  users.get("someone@example.com").password_hash = verifiedHash;
  const login = await post("login", { email: "someone@example.com", password: "old-password" });
  assert.equal(login.status, 200);

  const lookupIndex = queries.findIndex(([sql]) =>
    sql.includes("FROM users u LEFT JOIN profiles p") && sql.includes("FOR UPDATE"));
  const rehashIndex = queries.findIndex(([sql]) =>
    sql.includes("UPDATE users SET password_hash") && sql.includes("AND password_hash = ?"));
  const sessionIndex = queries.findIndex(([sql]) => sql.includes("INSERT INTO auth_sessions"));
  assert.ok(lookupIndex >= 0, "login query takes a user-row lock");
  assert.ok(rehashIndex > lookupIndex, "opportunistic rehash follows the locked password verification");
  assert.ok(sessionIndex > lookupIndex, "session insert follows the locked password verification");
  assert.equal(queries[rehashIndex][1][2], verifiedHash, "rehash is conditional on the exact hash that was verified");

  const connectionId = queries[lookupIndex][2];
  assert.equal(queries[rehashIndex][2], connectionId);
  assert.equal(queries[sessionIndex][2], connectionId);
  assert.deepEqual(transactionEvents.filter(([, id]) => id === connectionId).map(([event]) => event), ["begin", "commit"]);
});

test("a legacy unverified account receives its first OTP on login, without duplicate sends", async () => {
  reset();
  const legacyId = crypto.randomUUID();
  users.set("legacy@example.com", {
    id: legacyId, email: "legacy@example.com",
    password_hash: await bcrypt.hash("legacy-password", 10), email_verified_at: null,
  });
  const denied = await post("login", { email: "legacy@example.com", password: "legacy-password" });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "EMAIL_VERIFICATION_REQUIRED");
  assert.equal(queued.length, 1);
  assert.equal(verificationCodes.has(legacyId), true);
  assert.equal(queries.some(([sql]) => sql.includes("INSERT INTO auth_sessions")), false);
  await post("login", { email: "legacy@example.com", password: "legacy-password" });
  await post("resend-verification", { email: "legacy@example.com" });
  assert.equal(queued.length, 1, "existing code is not resent before cooldown");
  verificationCodes.get(legacyId).sentAt = 0;
  verificationCodes.get(legacyId).expires = Date.now() - 1;
  await post("login", { email: "legacy@example.com", password: "legacy-password" });
  assert.equal(queued.length, 2, "expired code is replaced on login");
  assert.equal((await post("verify-email", { email: "legacy@example.com", code: "654321" })).status, 200);
  assert.equal((await post("login", { email: "legacy@example.com", password: "legacy-password" })).status, 200);
});

test("an unverified administrator signs in without an OTP or a synthetic verified timestamp", async () => {
  reset();
  const admin = users.get("someone@example.com");
  admin.password_hash = await bcrypt.hash("admin-password", 10);
  admin.email_verified_at = null;
  admin.is_admin = 1;
  const login = await post("login", { email: "someone@example.com", password: "admin-password" });
  assert.equal(login.status, 200);
  assert.ok(login.setCookie);
  assert.equal(admin.email_verified_at, null);
  assert.equal(queued.length, 0);
  assert.equal(queries.some(([sql]) => sql.includes("INSERT INTO auth_sessions")), true);
  admin.is_admin = 0;
  const sessionsBeforeDemotion = queries.filter(([sql]) => sql.includes("INSERT INTO auth_sessions")).length;
  const deniedAfterDemotion = await post("login", { email: "someone@example.com", password: "admin-password" });
  assert.equal(deniedAfterDemotion.status, 403);
  assert.equal(deniedAfterDemotion.body.code, "EMAIL_VERIFICATION_REQUIRED");
  assert.equal(queries.filter(([sql]) => sql.includes("INSERT INTO auth_sessions")).length, sessionsBeforeDemotion);
  assert.equal(queued.length, 1);
});

test("resend creates the first OTP for a legacy account even before a fresh login", async () => {
  reset();
  users.set("legacy@example.com", { id: crypto.randomUUID(), email: "legacy@example.com", email_verified_at: null });
  const response = await post("resend-verification", { email: "legacy@example.com" });
  assert.equal(response.status, 200);
  assert.deepEqual(response, await post("resend-verification", { email: "missing@example.com" }));
  assert.equal(queued.length, 1);
});

test("wrong, expired, and resent verification codes are rejected or rotated", async () => {
  reset();
  await post("register", {
    email: "fresh@example.com", password: "signup-password", username: "newmember", country: "CI",
  });
  assert.equal((await post("verify-email", { email: "fresh@example.com", code: "999999" })).status, 400);
  const user = [...users.values()].find(item => item.email === "fresh@example.com");
  verificationCodes.get(user.id).expires = Date.now() - 1;
  assert.equal((await post("verify-email", { email: "fresh@example.com", code: "123456" })).status, 400);

  reset();
  await post("register", {
    email: "fresh@example.com", password: "signup-password", username: "newmember", country: "CI",
  });
  const resend1 = await post("resend-verification", { email: "fresh@example.com" });
  const resend2 = await post("resend-verification", { email: "fresh@example.com" });
  assert.deepEqual(resend1, resend2);
  assert.deepEqual(resend1, await post("resend-verification", { email: "missing@example.com" }));
  assert.equal(queued.length, 1, "cooldown blocks immediate resend");
  const resendState = verificationCodes.get([...users.values()].find(item => item.email === "fresh@example.com").id);
  resendState.sentAt = 0;
  await post("resend-verification", { email: "fresh@example.com" });
  assert.equal(queued.length, 2);
  assert.equal(queued[1].content.otp_code, "654321");
  assert.ok(queued[1].content.message.includes("654321"));
  assert.equal((await post("verify-email", { email: "fresh@example.com", code: "123456" })).status, 400);
  assert.equal((await post("verify-email", { email: "fresh@example.com", code: "654321" })).status, 200);
});

test("OTP reset consumes once, changes the password, and revokes all sessions", async () => {
  reset();
  await post("forgot-password", { email: "someone@example.com" });
  const code = queued[0].content.otp_code;
  const ok = await post("reset-password", { email: "someone@example.com", code, password: "new-password-123" });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.ok(await bcrypt.compare("new-password-123", users.get("someone@example.com").password_hash));
  assert.equal(sessions.size, 0);
  assert.equal([...tokens.values()][0].used_at !== null, true);
  assert.equal((await post("reset-password", { email: "someone@example.com", code, password: "another-password" })).status, 400);
  assert.equal((await post("reset-password", { email: "someone@example.com", code: "12x456", password: "another-password" })).status, 400);
  assert.equal((await post("reset-password", { email: "someone@example.com", code, password: "é".repeat(37) })).status, 400);
});

test("OTP reset errors do not reveal whether an email exists", async () => {
  reset();
  const absentAccount = await post("reset-password", {
    email: "missing@example.com", code: "123456", password: "new-password",
  });
  const absentCode = await post("reset-password", { email: "someone@example.com", password: "new-password" });
  const wrongCode = await post("reset-password", {
    email: "someone@example.com", code: "123456", password: "new-password",
  });
  assert.deepEqual(absentAccount.body, wrongCode.body);
  assert.equal(absentAccount.status, wrongCode.status);
  assert.equal(absentCode.status, 400);
});

test("wrong OTP attempts commit per token and stop after five; expired codes are rejected", async () => {
  reset();
  await post("forgot-password", { email: "someone@example.com" });
  const token = [...tokens.values()][0];
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await post("reset-password", { email: "someone@example.com", code: "999999", password: "new-password" })).status, 400);
  }
  assert.equal(token.attempts, 5);
  assert.equal((await post("reset-password", {
    email: "someone@example.com", code: queued[0].content.otp_code, password: "new-password",
  })).status, 400);
  assert.equal(token.attempts, 5);

  reset();
  await post("forgot-password", { email: "someone@example.com" });
  [...tokens.values()][0].expires_at = new Date(0);
  assert.equal((await post("reset-password", {
    email: "someone@example.com", code: queued[0].content.otp_code, password: "new-password",
  })).status, 400);
});

test("a resend invalidates the previous OTP and allows only the newest code", async () => {
  reset();
  await post("forgot-password", { email: "someone@example.com" });
  const oldCode = queued[0].content.otp_code;
  clock = new Date(clock.getTime() + 5 * 60_000);
  await post("forgot-password", { email: "someone@example.com" });
  assert.equal(queued.length, 2);
  assert.notEqual(queued[1].content.otp_code, oldCode);
  assert.ok([...tokens.values()][0].used_at !== null);
  assert.equal((await post("reset-password", {
    email: "someone@example.com", code: oldCode, password: "new-password",
  })).status, 400);
  const newest = await post("reset-password", {
    email: "someone@example.com", code: queued[1].content.otp_code, password: "new-password",
  });
  assert.equal(newest.status, 200, JSON.stringify(newest));
});

test("legacy links issued before OTP migration remain consumable once", async () => {
  reset();
  const raw = crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  tokens.set(hash, {
    id: crypto.randomUUID(), user_id: userId, expires_at: new Date(Date.now() + 30 * 60_000),
    used_at: null, attempts: 0, reset_type: "legacy",
  });
  assert.equal((await post("reset-password", { token: raw, password: "new-password" })).status, 200);
  assert.ok(await bcrypt.compare("new-password", users.get("someone@example.com").password_hash));
  assert.equal((await post("reset-password", { token: raw, password: "another-password" })).status, 400);
});