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
let tokens = new Map();
let limits = new Map();
let sessions = new Set();
let queued = [];
let queries = [];
const userId = crypto.randomUUID();

function reset() {
  clock = new Date("2026-01-01T00:00:00Z");
  users = new Map([["someone@example.com", { id: userId, password_hash: "old" }]]);
  tokens = new Map(); limits = new Map(); sessions = new Set([userId]); queued = []; queries = [];
  enabled = true; appUrl = true;
}
reset();
globalThis.__resetTest = {
  pool: {
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
        if (sql.includes("FROM users WHERE email")) {
          const user = users.get(args[0]);
          return [user ? [{ id: user.id }] : []];
        }
        if (sql.includes("INSERT INTO password_reset_tokens")) {
          tokens.set(args[2], { id: args[0], user_id: args[1], expires_at: args[3], used_at: null });
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("FROM password_reset_tokens WHERE token_hash")) {
          const token = tokens.get(args[0]);
          return [token ? [token] : []];
        }
        if (sql.includes("FROM users WHERE id")) return [[...users.values()].filter(user => user.id === args[0]).map(user => ({ id: user.id }))];
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
        if (sql.includes("INSERT INTO users")) return [{ affectedRows: 1 }];
        if (sql.includes("INSERT INTO profiles") || sql.includes("INSERT INTO user_roles") || sql.includes("INSERT INTO auth_sessions")) return [{ affectedRows: 1 }];
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    }),
  },
  enabled: () => enabled,
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
      build.onResolve({ filter: /^\.\.\/lib\/(mysql|auth|referrals|notification-outbox)$/ }, ({ path }) => ({ path, namespace: "mock" }));
      build.onResolve({ filter: /^\.\/notification-outbox$/ }, ({ path }) => ({ path, namespace: "mock" }));
      build.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({
        contents: path.endsWith("/mysql") ? "export const getMysqlPool = () => globalThis.__resetTest.pool;" :
          path.endsWith("/auth") ? "export const requireUser = (_req,_res,next) => next();" :
          path.endsWith("/referrals") ? "export const normalizeCode = x => x;" :
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
async function post(endpoint, body, ip) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json", ...(ip ? { "x-test-ip": ip } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
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

test("registration enqueues one stable welcome event inside its transaction", async () => {
  reset();
  const result = await post("register", {
    email: "fresh@example.com", password: "signup-password", username: "newmember", country: "CI",
  });
  assert.equal(result.status, 201);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].key, `signup-${result.body.user.id}`);
  assert.match(queued[0].content.title, /Bienvenue/);
  assert.equal(queued[0].content.action_url, undefined);
  reset();
  enabled = false;
  assert.equal((await post("register", {
    email: "fresh@example.com", password: "signup-password", username: "newmember", country: "CI",
  })).status, 201);
  assert.equal(queued.length, 0);
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