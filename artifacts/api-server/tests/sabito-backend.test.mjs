import assert from "node:assert/strict";
import { test, after } from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { fork } from "node:child_process";

const dir = await mkdtemp(fileURLToPath(new URL("../node_modules/sabito-backend-test-", import.meta.url)));
after(() => rm(dir, { recursive: true, force: true }));
const outfile = path.join(dir, "backend.mjs");
await build({
  stdin: {
    contents: `export {createSabitoHandlers} from "./src/lib/sabito-handlers";
      export {startSabitoBackend} from "./src/vendor/sabito-backend.mjs";`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts",
  },
  outfile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
  define: {
    "process.env.SABITO_URL": JSON.stringify("https://sabito.example"),
    "process.env.SABITO_CLIENT_ID": JSON.stringify("test-id"),
    "process.env.SABITO_CLIENT_SECRET": JSON.stringify("test-secret"),
  },
  plugins: [{
    name: "no-real-database",
    setup(build) {
      build.onResolve({ filter: /\/mysql$/ }, () => ({ path: "mysql", namespace: "mock" }));
      build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
        contents: `export function getMysqlPool(){throw new Error("Live DB prohibited in tests");}`,
      }));
    },
  }],
});
const { createSabitoHandlers, startSabitoBackend } = await import(pathToFileURL(outfile).href);
const job = (fields = {}, extra = {}) => ({
  external_user_id: "member-A", expires_at: new Date(Date.now() + 60000).toISOString(), fields, ...extra,
});
function setup({ user, payments = [], referral = "REALCODE" } = {}) {
  const calls = [];
  const member = user === undefined ? { id: "member-A", disabled_at: null, email_verified_at: "verified", is_admin: 0 } : user;
  const handlers = createSabitoHandlers(async (sql, params, signal) => {
    assert.match(sql, /^SELECT\s/);
    assert.ok(!sql.includes("SELECT *"));
    assert.equal(params[0], "member-A");
    signal?.throwIfAborted();
    calls.push({ sql, params });
    if (sql.includes("FROM users")) return member ? [member] : [];
    if (sql.includes("FROM payments")) {
      assert.match(sql, /WHERE user_id=\?/);
      return payments;
    }
    if (sql.includes("FROM profiles")) {
      assert.match(sql, /WHERE user_id=\?/);
      return [{ referral_code: referral }];
    }
    throw new Error("Unexpected query");
  });
  return { handlers, calls };
}

test("account activation reflects the real verified/disabled state without mutation", async () => {
  assert.deepEqual(await setup().handlers.account_activation(job()), { status: "active" });
  for (const [user, expected] of [
    [null, "not_found"],
    [{ disabled_at: "disabled", email_verified_at: "verified" }, "inactive"],
    [{ disabled_at: null, email_verified_at: null, is_admin: 0 }, "pending"],
    [{ disabled_at: null, email_verified_at: null, is_admin: 1 }, "active"],
  ]) assert.deepEqual(await setup({ user }).handlers.account_activation(job()), { status: expected });
});

test("deposit status maps actual payment state and refuses contradictory or unknown states", async () => {
  for (const [status, credited_at, expected] of [
    ["completed", "credited", "confirmed"], ["pending", null, "pending"],
    ["failed", null, "failed"], ["rejected", null, "failed"],
    ["completed", null, "error"], ["pending", "credited", "error"],
    ["unknown-state", null, "error"],
  ]) {
    const { handlers } = setup({ payments: [{ status, credited_at, private_field: "must-not-leak" }] });
    assert.deepEqual(await handlers.deposit_status(job({ transaction_id: "tx-123" })), { status: expected });
  }
});

test("transaction lookup always includes owner; both supplied references must match", async () => {
  const { handlers, calls } = setup();
  assert.deepEqual(await handlers.deposit_status(job({
    deposit_number: "deposit' OR 1=1 --", transaction_id: "someone-elses-tx",
  })), { status: "not_found" });
  const lookup = calls.at(-1);
  assert.match(lookup.sql, /user_id=\?.* AND .* AND transaction_id=\?/);
  assert.ok(!lookup.sql.includes("OR 1=1"));
  assert.deepEqual(lookup.params, [
    "member-A", ...Array(4).fill("deposit' OR 1=1 --"), "someone-elses-tx",
  ]);
});

test("no reference does not trigger a broad search or a guessed latest deposit", async () => {
  const { handlers, calls } = setup();
  assert.deepEqual(await handlers.deposit_status(job()), { status: "error" });
  assert.equal(calls.length, 1); // Member lookup only, never the payments table.
});

test("a missing/foreign or ambiguous deposit is never confirmed", async () => {
  assert.deepEqual(await setup().handlers.deposit_status(job({ transaction_id: "foreign" })), { status: "not_found" });
  const { handlers } = setup({ payments: [{}, {}] });
  assert.deepEqual(await handlers.deposit_status(job({ deposit_number: "ambiguous" })), { status: "error" });
});

test("disabled or unverified members cannot read financial or referral data", async () => {
  for (const user of [
    { disabled_at: "disabled", email_verified_at: "verified" },
    { disabled_at: null, email_verified_at: null, is_admin: 0 },
  ]) {
    const { handlers, calls } = setup({ user });
    assert.deepEqual(await handlers.deposit_status(job({ transaction_id: "x" })), { status: "forbidden" });
    assert.deepEqual(await handlers.referral_code(job()), { status: "forbidden" });
    assert.equal(calls.length, 2);
    assert.ok(calls.every(c => c.sql.includes("FROM users")));
  }
});

test("the existing referral code alone is returned; absent codes are never generated", async () => {
  assert.deepEqual(await setup().handlers.referral_code(job()), { status: "ok", code: "REALCODE" });
  for (const referral of [null, ""]) {
    assert.deepEqual(await setup({ referral }).handlers.referral_code(job()), { status: "not_found" });
  }
  assert.deepEqual(await setup({ referral: "unsafe content" }).handlers.referral_code(job()), { status: "error" });
});

test("untrusted, expired and cancelled identities fail before any query", async () => {
  for (const extra of [
    { external_user_id: "" }, { external_user_id: "guest:abc" },
    { external_user_id: "sabito-admin-preview" }, { external_user_id: { id: "member-A" } },
    { expires_at: "invalid" }, { expires_at: "2000-01-01" }, { signal: AbortSignal.abort() },
  ]) {
    const { handlers, calls } = setup();
    await handlers.deposit_status(job({ transaction_id: "x" }, extra));
    assert.equal(calls.length, 0);
  }
});

test("database failures never leak SQL, identifiers, credentials or fabricated results", async () => {
  const handlers = createSabitoHandlers(async () => { throw new Error("private SQL and credentials"); });
  for (const handler of Object.values(handlers)) {
    assert.deepEqual(await handler(job({ transaction_id: "x" })), { status: "error" });
  }
  assert.equal(handlers.withdrawal_status, undefined);
});

test("the official SDK polls exact operations and submits only the authorized result (simulated server)", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const { handlers } = setup({ payments: [{ status: "completed", credited_at: "credited" }] });
  let polled = false;
  let submitted = false;
  globalThis.fetch = async (url, init) => {
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from("test-id:test-secret").toString("base64")}`);
    assert.equal(init.headers.Origin, undefined);
    assert.equal(init.redirect, "error");
    if (String(url).endsWith("/jobs/poll")) {
      polled = true;
      assert.deepEqual(JSON.parse(init.body).operations.sort(), [
        "account_activation", "deposit_status", "referral_code",
      ]);
      return Response.json({ jobs: [{
        ...job({ transaction_id: "real-owned-fixture" }),
        id: "12345678-1234-1234-1234-123456789abc", operation: "deposit_status",
      }] });
    }
    assert.match(String(url), /\/jobs\/12345678-1234-1234-1234-123456789abc\/result$/);
    assert.deepEqual(JSON.parse(init.body), { result: { status: "confirmed" } });
    submitted = true;
    controller.abort();
    return Response.json({ ok: true });
  };
  try {
    await startSabitoBackend({ handlers, signal: controller.signal, onError: code => assert.fail(code) });
    assert.equal(polled, true);
    assert.equal(submitted, true);
  } finally {
    controller.abort(); globalThis.fetch = originalFetch;
  }
});

test("a database failure releases worker IPC and exits for supervisor restart, without polling", async () => {
  const workerFile = path.join(dir, "worker-failure.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/scripts/sabito-worker.ts", import.meta.url))],
    outfile: workerFile, bundle: true, platform: "node", format: "esm",
    packages: "external", logLevel: "silent",
    define: {
      "process.env.SABITO_URL": JSON.stringify("https://sabito.example"),
      "process.env.SABITO_CLIENT_ID": JSON.stringify("test-id"),
      "process.env.SABITO_CLIENT_SECRET": JSON.stringify("test-secret"),
    },
    plugins: [{
      name: "database-unreachable",
      setup(build) {
        build.onResolve({ filter: /\/mysql$/ }, () => ({ path: "mysql", namespace: "mock" }));
        build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
          contents: `export function getMysqlPool(){return {async getConnection(){
            const error=new Error("private database credentials");error.code="ECONNREFUSED";throw error;
          }}};export async function closeMysqlPool(){}`,
        }));
      },
    }],
  });
  const child = fork(workerFile, [], {
    env: { NODE_ENV: "test" }, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages = [];
  let output = "";
  child.on("message", m => messages.push(m));
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    const [code, signal] = await new Promise(resolve => child.once("exit", (...args) => resolve(args)));
    assert.equal(signal, null, "Worker must exit itself rather than hang on IPC");
    assert.equal(code, 1);
    assert.deepEqual(messages, [{ type: "sabito", event: "fatal", code: "ECONNREFUSED" }]);
    assert.equal(output, "");
  } finally {
    clearTimeout(timeout);
    child.kill("SIGKILL");
  }
});
