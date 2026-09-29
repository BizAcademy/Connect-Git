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
let appUrl = true;
let clock = new Date("2026-01-01T00:00:00Z");
let users = new Map();
let profiles = new Map();
let tokens = new Map();
let limits = new Map();
let sessions = new Set();
let queued = [];
let queries = [];
let verificationCodes = new Map();
const userId = crypto.randomUUID();

function reset() {
  clock = new Date("2026-01-01T00:00:00Z");
  users = new Map([["someone@example.com", { id: userId, email: "someone@example.com", password_hash: "old", email_verified_at: new Date() }]]);
  profiles = new Map();
  tokens = new Map(); limits = new Map(); sessions = new Set([userId]); queued = []; queries = [];
  verificationCodes = new Map();
  if (globalThis.__resetTest) {
    globalThis.__resetTest.users = users;
    globalThis.__resetTest.verificationCodes = verificationCodes;
    globalThis.__resetTest.queued = queued;
  }
  enabled = true; appUrl = true;
}
reset();
globalThis.__resetTest = {
  pool: {
    execute: async (sql, args = []) => {
      const connection = await globalThis.__resetTest.pool.getConnection();
      return connection.execute(sql, args);
    },
    getConnection: async () => ({
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
      execute: async (sql, args = []) => {
        queries.push([sql, args]);
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
          return [user ? [{ ...profiles.get(user.id), ...user, is_admin: 0 }] : []];
        }
        if (sql.includes("FROM users WHERE email")) {
          const user = users.get(args[0]);
          return [user ? [{ id: user.id, email_verified_at: user.email_verified_at }] : []];
        }
        if (sql.includes("INSERT INTO password_reset_tokens")) {
          tokens.set(args[2], { id: args[0], user_id: args[1], expires_at: args[3], used_at: null });
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("FROM password_reset_tokens WHERE token_hash")) {
          const token = tokens.get(args[0]);
          return [token ? [token] : []];
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
    }),
  },
  enabled: () => enabled,
  users,
  verificationCodes,
  queued,
  action: (p) => { if (!appUrl) throw new Error("No trusted app URL"); return `https://app.example${p}`; },
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
      build.onResolve({ filter: /^\.\/notification-outbox$/ }, ({ path }) => ({ path, namespace: "mock" }));
      build.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({
        contents: path.endsWith("/mysql") ? "export const getMysqlPool = () => globalThis.__resetTest.pool;" :
          path.endsWith("/auth") ? "export const requireUser = (_req,_res,next) => next();" :
          path.endsWith("/referrals") ? "export const normalizeCode = x => x;" :
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

test("unknown and known requests have identical public responses; only known account queues a hashed token", async () => {
  reset();
  const unknown = await post("forgot-password", { email: "missing@example.com" });
  clock = new Date(clock.getTime() + 61_000);
  const known = await post("forgot-password", { email: "someone@example.com" });
  assert.deepEqual(known, unknown);
  assert.equal(queued.length, 1);
  assert.match(queued[0].key, /^password-reset-/);
  const link = queued[0].content.action_url;
  assert.match(link, /^https:\/\/app\.example\/reset-password#token=/);
  assert.equal(new URL(link).search, "");
  const raw = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
  assert.equal(raw.length, 43);
  assert.ok(tokens.has(crypto.createHash("sha256").update(raw).digest("hex")));
  assert.ok(!queries.some(([sql, args]) => sql.includes("password_reset_tokens") && args.includes(raw)));
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

test("missing delivery config or trusted URL fails closed for both account states", async () => {
  for (const key of ["enabled", "url"]) {
    reset();
    if (key === "enabled") enabled = false; else appUrl = false;
    const unknown = await post("forgot-password", { email: "missing@example.com" });
    const known = await post("forgot-password", { email: "someone@example.com" });
    assert.deepEqual(unknown, known);
    assert.equal(known.status, 503);
    assert.equal(queued.length, 0);
  }
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

test("valid reset rotates password, consumes all tokens, revokes sessions; replay/expiry fails", async () => {
  reset();
  await post("forgot-password", { email: "someone@example.com" });
  const raw = new URLSearchParams(new URL(queued[0].content.action_url).hash.slice(1)).get("token");
  const ok = await post("reset-password", { token: raw, password: "new-password-123" });
  assert.equal(ok.status, 200);
  assert.ok(await bcrypt.compare("new-password-123", users.get("someone@example.com").password_hash));
  assert.equal(sessions.size, 0);
  assert.equal([...tokens.values()][0].used_at !== null, true);
  assert.equal((await post("reset-password", { token: raw, password: "another-password" })).status, 400);
  assert.equal((await post("reset-password", { token: "invalid", password: "another-password" })).status, 400);
  assert.equal((await post("reset-password", { token: raw, password: "é".repeat(40) })).status, 400);
  reset();
  await post("forgot-password", { email: "someone@example.com" });
  clock = new Date(clock.getTime() + 31 * 60_000);
  const expired = new URLSearchParams(new URL(queued[0].content.action_url).hash.slice(1)).get("token");
  // Date.now is wall clock in production; the fixture's expiry must be in the past.
  [...tokens.values()][0].expires_at = new Date(0);
  assert.equal((await post("reset-password", { token: expired, password: "another-password" })).status, 400);
});