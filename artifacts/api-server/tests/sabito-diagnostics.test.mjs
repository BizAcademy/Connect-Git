import assert from "node:assert/strict";
import { test, after } from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = await mkdtemp(path.join(tmpdir(), "sabito-diagnostics-"));
after(() => rm(dir, { recursive: true, force: true }));
const root = fileURLToPath(new URL("..", import.meta.url));
const outfile = path.join(dir, "diagnostics.mjs");
await build({
  stdin: {
    contents: 'export * from "./src/lib/sabito-diagnostics"; export * from "./src/lib/sabito-runtime";',
    resolveDir: root, loader: "ts",
  },
  outfile, platform: "node", bundle: true, format: "esm", logLevel: "silent",
  plugins: [{
    name: "no-real-database",
    setup(b) {
      b.onResolve({ filter: /^\.\/mysql$/ }, () => ({ path: "mysql", namespace: "mock" }));
      b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
        contents: 'export const getMysqlPool=()=>{throw Error("Live database forbidden in tests")};', loader: "js",
      }));
    },
  }],
});
const { runSabitoDiagnostics, diagnosticCode, shouldStartSabito } = await import(pathToFileURL(outfile).href);
const env = { SABITO_URL: "https://sabito.example", SABITO_CLIENT_ID: "PRIVATE-ID", SABITO_CLIENT_SECRET: "PRIVATE-SECRET" };
const database = async sql => {
  assert.match(sql, /^SELECT /);
  assert.ok(sql === "SELECT 1" || sql.endsWith("LIMIT 0"));
};
const request = async (input, init) => {
  assert.equal(String(input), "https://sabito.example/v1/backend/jobs/poll");
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from("PRIVATE-ID:PRIVATE-SECRET").toString("base64")}`);
  assert.equal(init.redirect, "error");
  assert.deepEqual(JSON.parse(init.body), { operations: [] });
  return Response.json({ jobs: [] });
};
test("probe checks HTTPS auth and schema without claiming jobs or reading a member", async () => {
  const result = await runSabitoDiagnostics({ env, nodeMajor: 24, request, read: database });
  assert.equal(result.ok, true);
  assert.ok(result.checks.some(c => c.code === "HTTPS_AUTH_OK_NO_OPERATIONS"));
  assert.equal(result.checks.filter(c => c.code === "SCHEMA_READABLE").length, 7);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});
test("database refusal remains explicit even when Sabito HTTPS authentication succeeds", async () => {
  const result = await runSabitoDiagnostics({
    env, request, read: async () => { throw Object.assign(new Error("PRIVATE"), { code: "ECONNREFUSED" }); },
  });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some(c => c.stage === "database" && c.code === "ECONNREFUSED"));
  assert.ok(result.checks.some(c => c.code === "HTTPS_AUTH_OK_NO_OPERATIONS"));
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});
test("credential rejection and TLS errors remain distinct, without response bodies", async () => {
  for (const status of [401, 403, 429, 500]) {
    const result = await runSabitoDiagnostics({ env, read: database, request: async () => Response.json({ secret: "PRIVATE" }, { status }) });
    assert.equal(result.ok, false);
    assert.ok(result.checks.some(c => c.http === status && c.code === "POLL_REJECTED"));
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  }
  assert.equal(diagnosticCode({ cause: { code: "CERT_HAS_EXPIRED", message: "PRIVATE" } }, "UNKNOWN"), "CERT_HAS_EXPIRED");
  assert.equal(diagnosticCode({ code: "PRIVATE" }, "UNKNOWN"), "UNKNOWN");
});
test("schema failure reports its stage and sanitized database code", async () => {
  const result = await runSabitoDiagnostics({ env, request, read: async sql => {
    await database(sql);
    if (sql.includes("FROM payments")) throw Object.assign(new Error("PRIVATE"), { code: "ER_BAD_FIELD_ERROR" });
  } });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some(c => c.stage === "schema_payments" && c.code === "ER_BAD_FIELD_ERROR"));
});
test("invalid URLs, absent credentials and unsupported Node never appear healthy", async () => {
  for (const url of ["http://sabito.example", "https://user:PRIVATE@sabito.example", "https://sabito.example/path"]) {
    const result = await runSabitoDiagnostics({
      env: { ...env, SABITO_URL: url }, read: database,
      request: async () => assert.fail("invalid URL must not be called"),
    });
    assert.equal(result.ok, false);
    assert.ok(result.checks.some(c => c.code === "SABITO_URL_INVALID"));
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  }
  assert.equal((await runSabitoDiagnostics({ env, request, read: database, nodeMajor: 20 })).ok, false);
});
test("production startup includes direct Passenger launch but excludes preview, dev and tests", () => {
  for (const nodeEnv of [undefined, "", "production", "staging"]) assert.equal(shouldStartSabito(nodeEnv, false), true);
  for (const nodeEnv of ["development", "test"]) assert.equal(shouldStartSabito(nodeEnv, false), false);
  assert.equal(shouldStartSabito("production", true), false);
});
test("deployment bundle advertises SDK-compatible Node and production launch scripts", async () => {
  const buildScript = await readFile(path.join(root, "../../build-for-plesk.sh"), "utf8");
  assert.ok(buildScript.includes('"node": ">=21"'));
  assert.ok(buildScript.includes('NODE_ENV=${NODE_ENV:-production}'));
  assert.ok(buildScript.includes('"sabito:check"'));
  const config = await readFile(path.join(root, "../../ecosystem.sabito.config.cjs"), "utf8");
  assert.ok(config.includes("autorestart: true"));
  assert.ok(config.includes("instances: 1"));
  assert.equal(/SABITO_CLIENT_(ID|SECRET)\s*:/.test(config), false);
});

test("supervisor restarts on spawn errors and exits, without scheduling duplicate children", async () => {
  const supervisorFile = path.join(dir, "supervisor.mjs");
  await build({
    entryPoints: [path.join(root, "src/lib/sabito-supervisor.ts")],
    outfile: supervisorFile, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    define: { setTimeout: "globalThis.__sabitoTimer", clearTimeout: "globalThis.__sabitoClearTimer" },
    plugins: [{
      name: "fake-processes",
      setup(b) {
        b.onResolve({ filter: /^(node:child_process|\.\/logger)$/ }, args => ({ path: args.path, namespace: "supervisor-mock" }));
        b.onLoad({ filter: /.*/, namespace: "supervisor-mock" }, args => ({
          contents: args.path === "./logger"
            ? 'export const logger={info(){},warn(){}};'
            : `import {EventEmitter} from "node:events";
               export const fork=()=>{const c=new EventEmitter();c.kill=()=>{};globalThis.__sabitoChildren.push(c);return c;};`,
          loader: "js",
        }));
      },
    }],
  });
  const events = ["SIGTERM", "SIGINT", "exit"];
  const before = Object.fromEntries(events.map(e => [e, process.listeners(e)]));
  globalThis.__sabitoChildren = [];
  const scheduled = [];
  globalThis.__sabitoTimer = (callback, ms) => { scheduled.push({ callback, ms }); return { unref() {} }; };
  globalThis.__sabitoClearTimer = () => {};
  try {
    const { startSabitoSupervisor } = await import(pathToFileURL(supervisorFile).href);
    startSabitoSupervisor("unused-fixture-worker");
    assert.equal(globalThis.__sabitoChildren.length, 1);
    const child = globalThis.__sabitoChildren[0];
    child.emit("error", new Error("PRIVATE"));
    child.emit("exit", 1);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, 2000);
    scheduled.shift().callback();
    assert.equal(globalThis.__sabitoChildren.length, 2);
    globalThis.__sabitoChildren[1].emit("exit", 1);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, 4000);
  } finally {
    for (const event of events) {
      for (const listener of process.listeners(event)) if (!before[event].includes(listener)) process.removeListener(event, listener);
    }
    delete globalThis.__sabitoTimer; delete globalThis.__sabitoClearTimer; delete globalThis.__sabitoChildren;
  }
});
