import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { build } from "esbuild";

// No real database, login or Sabito credentials are used by these tests.
const dir = await mkdtemp(fileURLToPath(new URL("../node_modules/sabito-test-", import.meta.url)));
after(() => rm(dir, { recursive: true, force: true }));
const sessions = new Map();
globalThis.__sabitoTestSessions = sessions;
after(() => { delete globalThis.__sabitoTestSessions; });
const outfile = path.join(dir, "sabito.mjs");
await build({
  stdin: {
    contents: `export * from "./src/lib/sabito-session.ts";
      export { createSabitoRouter } from "./src/routes/sabito.ts";`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "ts",
  },
  outfile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
  plugins: [{
    name: "no-live-resources",
    setup(build) {
      build.onResolve({ filter: /(?:^|\/)(mysql|logger)$/ }, ({ path }) => ({ path, namespace: "safe-mock" }));
      build.onLoad({ filter: /.*/, namespace: "safe-mock" }, ({ path }) => ({
        contents: path.endsWith("mysql") ? `
          export function getMysqlPool() { return {
            async execute(sql, [hash]) {
              if (!sql.includes("s.revoked_at IS NULL") || !sql.includes("s.expires_at > NOW()"))
                throw new Error("Authentication must check revocation and expiration");
              const session = globalThis.__sabitoTestSessions.get(hash);
              return [[session && !session.revoked && !session.expired ? {user_id:session.userId} : undefined].filter(Boolean)];
            }
          }; }` : `export const logger = {warn(){}, error(){}};`,
        loader: "js",
      }));
    },
  }],
});
const { exchangeSabitoSession, SabitoSessionError, createSabitoRouter } = await import(pathToFileURL(outfile).href);
const config = { clientId: "test-client", clientSecret: "test-secret", url: "https://sabito.example" };
const payload = (overrides = {}) => ({
  success: true,
  data: {
    access_token: "test-short-lived-token", identity_type: "platform_user",
    external_user_id: "member-A", expires_in: 900, socket_path: "/socket.io",
    socket_url: "https://sabito.example", ...overrides,
  },
});
const upstream = (value = payload(), status = 200) => async () => Response.json(value, { status });

test("exchange uses server-only Basic auth and returns only the four documented fields", async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const result = await exchangeSabitoSession("member-A", signal, config, async (url, init) => {
    calls++;
    assert.equal(String(url), "https://sabito.example/v1/auth/token");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), { external_user_id: "member-A" });
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from("test-client:test-secret").toString("base64")}`);
    assert.equal(init.headers.Origin, undefined);
    assert.equal(init.headers.Cookie, undefined);
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json(payload());
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    access_token: "test-short-lived-token", expires_in: 900,
    socket_path: "/socket.io", external_user_id: "member-A",
  });
});

test("mismatched identities, guest sessions, bad TTLs and malformed responses fail closed", async () => {
  for (const value of [
    null, {}, { success: false, data: payload().data },
    payload({ external_user_id: "member-B" }), payload({ identity_type: "visitor" }),
    payload({ access_token: "" }), payload({ access_token: " " }),
    ...[0, -1, 901, "900", 1.5].map(expires_in => payload({ expires_in })),
    payload({ socket_path: "https://evil.example" }), payload({ socket_path: "//evil.example" }),
    payload({ socket_path: "/\\evil" }),
  ]) {
    await assert.rejects(exchangeSabitoSession("member-A", undefined, config, upstream(value)),
      error => error instanceof SabitoSessionError && error.status === 502);
  }
});

test("reserved or invalid server identities never reach Sabito", async () => {
  for (const id of ["", " x ", "x".repeat(192), "guest:123", "sabito-admin-preview"]) {
    await assert.rejects(exchangeSabitoSession(id, undefined, config, () => {
      assert.fail("Invalid identity must not reach the network");
    }), { code: "IDENTITY" });
  }
});

test("missing credentials and unsafe server URLs fail without a network request", async () => {
  for (const bad of [
    {}, { ...config, clientSecret: "" }, { ...config, url: "" },
    { ...config, url: "http://sabito.example" },
    { ...config, url: "https://user:password@sabito.example" },
    { ...config, url: "https://sabito.example/api" },
    { ...config, url: "https://sabito.example/?secret=value" },
  ]) {
    await assert.rejects(exchangeSabitoSession("member-A", undefined, bad, () => {
      assert.fail("Invalid configuration must not reach the network");
    }), { code: "CONFIGURATION", status: 503 });
  }
});

test("upstream credential failures cannot sign the member out; errors contain no secrets", async () => {
  for (const [status, localStatus] of [[401, 502], [403, 502], [429, 503], [503, 503]]) {
    await assert.rejects(exchangeSabitoSession("member-A", undefined, config, upstream({ secret: "test-secret" }, status)),
      error => error.status === localStatus && !error.message.includes("test-secret"));
  }
  await assert.rejects(exchangeSabitoSession("member-A", undefined, config, async () => {
    throw new Error("test-secret test-short-lived-token");
  }), error => error.status === 502 && !error.message.includes("test-secret"));
});

test("caller cancellation and upstream deadline are passed through to fetch", async (t) => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(exchangeSabitoSession("member-A", controller.signal, config, async (_url, init) => {
    assert.equal(init.signal.aborted, true);
    init.signal.throwIfAborted();
  }), { code: "UPSTREAM" });
  const timeout = t.mock.method(AbortSignal, "timeout", () => AbortSignal.abort());
  try {
    await assert.rejects(exchangeSabitoSession("member-A", undefined, config, async (_url, init) => {
      init.signal.throwIfAborted();
    }), { code: "TIMEOUT", status: 504 });
  } finally {
    timeout.mock.restore();
  }
});

test("member route checks real auth middleware, origin, body, renewal, errors and limits without live resources", async () => {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  let calls = 0;
  let fail = false;
  app.use("/api", createSabitoRouter(async (userId, signal) => {
    calls++;
    assert.ok(signal instanceof AbortSignal);
    if (fail) throw new SabitoSessionError("CONFIGURATION", 503);
    return {
      access_token: `test-token-${calls}`, expires_in: 900,
      socket_path: "/socket.io", external_user_id: userId,
    };
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  function session(token, state) {
    sessions.set(createHash("sha256").update(token).digest("hex"), state);
  }
  session("active-A", { userId: "member-A" });
  session("active-B", { userId: "member-B" });
  session("revoked", { userId: "member-A", revoked: true });
  session("expired", { userId: "member-A", expired: true });
  async function request({ token = "active-A", headers = {}, body = "{}" } = {}) {
    return fetch(`${origin}/api/sabito/session`, {
      method: "POST", headers: {
        "Content-Type": "application/json", Origin: origin,
        ...(token ? { Cookie: `bb_session=${token}` } : {}), ...headers,
      }, body,
    });
  }
  try {
    for (const token of [null, "unknown", "revoked", "expired"]) {
      const response = await request({ token });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("cache-control"), "no-store");
      await response.text();
    }
    assert.equal(calls, 0);
    for (const headers of [
      { Origin: "https://evil.example" }, { Origin: "null" }, { Origin: "" },
      { Origin: `${origin}.evil.example` }, { "Sec-Fetch-Site": "cross-site" },
    ]) {
      const response = await request({ headers });
      assert.equal(response.status, 403);
      await response.text();
    }
    let response = await request({ headers: { "Content-Type": "text/plain" } });
    assert.equal(response.status, 415);
    await response.text();
    for (const body of ['{"external_user_id":"member-B"}', "[]", '{"external_user_name":"Fake"}']) {
      response = await request({ body });
      assert.equal(response.status, 400);
      await response.text();
    }
    assert.equal(calls, 0);
    response = await request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("pragma"), "no-cache");
    const first = await response.json();
    assert.equal(first.external_user_id, "member-A");
    response = await request();
    const renewed = await response.json();
    assert.notEqual(renewed.access_token, first.access_token);
    session("active-A", { userId: "member-A", revoked: true });
    response = await request();
    assert.equal(response.status, 401);
    await response.text();
    response = await request({ token: "active-B" });
    assert.equal((await response.json()).external_user_id, "member-B");
    fail = true;
    response = await request({ token: "active-B" });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "Sabito est temporairement indisponible. Réessayez plus tard.");
    fail = false;
    session("rate-limit", { userId: "limited-member" });
    for (let i = 0; i < 20; i++) {
      response = await request({ token: "rate-limit" });
      assert.equal(response.status, 200);
      await response.text();
    }
    const beforeLimit = calls;
    response = await request({ token: "rate-limit" });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(calls, beforeLimit);
    await response.text();
    response = await request({ token: "active-B" });
    assert.equal(response.status, 200, "One member's limit must not affect another member");
    await response.text();
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("disconnecting the browser aborts the pending server exchange", async () => {
  const app = express();
  app.use(cookieParser(), express.json());
  let entered;
  let aborted;
  const started = new Promise(resolve => { entered = resolve; });
  const cancelled = new Promise(resolve => { aborted = resolve; });
  app.use("/api", createSabitoRouter((_userId, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      aborted();
      reject(new Error("Cancelled"));
    }, { once: true });
    entered();
  })));
  const token = "cancellation-test";
  sessions.set(createHash("sha256").update(token).digest("hex"), { userId: "cancelled-member" });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  try {
    const pending = fetch(`${origin}/api/sabito/session`, {
      method: "POST", body: "{}", signal: controller.signal,
      headers: { "Content-Type": "application/json", Origin: origin, Cookie: `bb_session=${token}` },
    });
    await Promise.race([
      started, new Promise((_, reject) => setTimeout(() => reject(new Error("Exchange did not start")), 2000).unref()),
    ]);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await Promise.race([
      cancelled, new Promise((_, reject) => setTimeout(() => reject(new Error("Exchange was not cancelled")), 2000).unref()),
    ]);
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
