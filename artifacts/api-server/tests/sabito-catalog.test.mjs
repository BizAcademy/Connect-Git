import assert from "node:assert/strict";
import { test, after } from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const dir = await mkdtemp(fileURLToPath(new URL("../node_modules/sabito-catalog-test-", import.meta.url)));
after(() => rm(dir, { recursive: true, force: true }));
const outfile = path.join(dir, "catalog.mjs");
await build({
  stdin: { contents: `export {catalogServices} from "./src/lib/sabito-catalog";
    export {createSabitoHandlers} from "./src/lib/sabito-handlers";`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts" },
  outfile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
  plugins: [{ name: "no-live-db", setup(b) {
    b.onResolve({ filter: /\/mysql$/ }, () => ({ path: "mysql", namespace: "mock" }));
    b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
      contents: `export function getMysqlPool(){throw new Error("Live DB prohibited");}`,
    }));
  } }],
});
const { catalogServices, createSabitoHandlers } = await import(pathToFileURL(outfile).href);
const service = (id, extra = {}) => ({ service: id, name: `Instagram Followers ${id}`,
  category: "Instagram", min: 10, max: 10000, rate: "1", type: "Default",
  description: "<b>Catalogue description</b>", refill: true, ...extra });
const stat = (id, orders, completed, extra = {}) => ({
  provider: 4, service_id: String(id), orders, completed, ...extra,
});
function fixture(fields = {}, changes = {}) {
  const data = { providers: [{ provider_id: 4, header_title: "Catalogue public" }],
    services: [service(1), service(2), service(3), service(4)],
    stats: [stat(1, 100, 80, { failed: 20 }), stat(2, 1, 1), stat(3, 200, 100, { partial: 50, canceled: 50 })],
    prices: [], settings: [], ...changes };
  const calls = [];
  let requests = 0;
  const read = async (sql, params) => {
    assert.match(sql, /^SELECT\s/);
    assert.doesNotMatch(sql, /SELECT \*|\b(INSERT|UPDATE|DELETE|CALL)\b/i);
    calls.push({ sql, params });
    if (sql.includes("FROM users")) return [{ id: "member", email_verified_at: "2026-01-01" }];
    if (sql.includes("smm_providers_config")) return data.providers;
    if (sql.includes("FROM orders")) return data.stats;
    if (sql.includes("FROM smm_pricing")) return data.prices;
    if (sql.includes("FROM settings")) return data.settings;
    throw new Error("Unexpected query");
  };
  const job = { external_user_id: "member", expires_at: new Date(Date.now() + 60000).toISOString(), fields };
  const ctx = { id: "member", job, read };
  const remote = async () => { requests++; if (data.fail) throw new Error("PRIVATE"); return data.services; };
  const run = async (recommend = false) => {
    const result = await catalogServices(ctx, remote, recommend, () => true);
    assert.ok(Object.keys(result.data).length <= 32);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|apiKey|rate_usd|user_id/);
    for (const value of Object.values(result.data)) {
      assert.ok(value == null || ["string", "number", "boolean"].includes(typeof value));
      if (typeof value === "string") assert.ok(value.length <= 2000);
    }
    return result;
  };
  return { ctx, data, calls, run, read, remote, requests: () => requests };
}
test("fresh catalogue per call; public selling price only; stable 3-item pagination", async () => {
  const f = fixture();
  const r = await f.run();
  assert.equal(r.status, "ok");
  assert.equal(r.data.service_1_id, "3");
  assert.equal(r.data.nombre_correspondances, 4);
  assert.equal(r.data.page_suivante, "2");
  assert.deepEqual(JSON.parse(r.data.service_1_prix), { devise: "XAF", par_1000: 800, quantite: null, total: null });
  assert.equal(r.data.service_1_description, "Catalogue description");
  f.ctx.job.fields = { page: "2" };
  assert.equal((await f.run()).data.service_1_id, "4");
  assert.equal(f.requests(), 2);
});
test("reliability accounts for sample size; completed and popular are separate sorts", async () => {
  const f = fixture();
  assert.equal((await f.run(true)).data.service_1_id, "1");
  f.ctx.job.fields.sort = "completed";
  assert.equal((await f.run(true)).data.service_1_id, "3");
  f.ctx.job.fields.sort = "popular";
  assert.equal((await f.run(true)).data.service_1_id, "3");
});
test("aggregate by provider + service ID, never by ambiguous display name", async () => {
  const f = fixture({}, { services: [service(1), service(2, { name: "Instagram Followers 1" })] });
  const r = await f.run();
  assert.equal(JSON.parse(r.data.service_1_statistiques).orders, 100);
  assert.equal(JSON.parse(r.data.service_2_statistiques).orders, 1);
  const sql = f.calls.find(c => c.sql.includes("FROM orders"));
  assert.match(sql.sql, /GROUP BY provider, service_id/);
  assert.doesNotMatch(sql.sql, /\buser_id\b|\blink\b|service_name/);
  assert.equal(sql.params.length, 1);
});
test("pending orders do not count as failures; partial/refund/cancel do not count as completed", async () => {
  const r = await fixture({}, { stats: [stat(1, 100, 10, { failed: 2, partial: 3, refunded: 4, canceled: 1 })] }).run();
  const s = JSON.parse(r.data.service_1_statistiques);
  assert.equal(s.pending, 80);
  assert.equal(s.closed, 20);
  assert.equal(s.completion_rate, 50);
});
test("French goal aliases, quantity limits and total budget filter", async () => {
  const r = await fixture({ network: "Instagram", goal: "abonnés", quantity: "1000", budget_xaf: "500" },
    { prices: [{ provider: 4, service_id: "2", price_minor: 400, hidden: 0 }] }).run(true);
  assert.equal(r.data.nombre_correspondances, 1);
  assert.equal(r.data.service_1_id, "2");
  assert.equal(JSON.parse(r.data.service_1_prix).total, 400);
  assert.equal((await fixture({ quantity: "1" }).run()).data.nombre_correspondances, 0);
});
test("hidden, unsupported, invalid and duplicate services never recommended", async () => {
  const r = await fixture({}, { services: [service(1), service(1), service(2, { type: "Custom Comments" }),
    service(3, { min: "invalid" }), service(4)], prices: [{ provider: 4, service_id: "4", hidden: 1 }] }).run();
  assert.equal(r.data.nombre_correspondances, 1);
});
test("provider selection excludes unconfigured providers without contacting them", async () => {
  const f = fixture({}, { providers: [{ provider_id: 4 }, { provider_id: 5 }] });
  const contacted = [];
  const r = await catalogServices(f.ctx, async id => { contacted.push(id); return f.data.services; },
    false, id => id === 4);
  assert.deepEqual(contacted, [4]);
  assert.equal(r.data.nombre_correspondances, 4);
  assert.match(f.calls[0].sql, /WHERE enabled=1/);
});
test("removed or hidden offers disappear on subsequent calls, no stale catalogue cache", async () => {
  const f = fixture();
  assert.equal((await f.run()).data.nombre_correspondances, 4);
  f.data.services = [service(1), service(2)];
  f.data.prices = [{ provider: 4, service_id: "1", hidden: 1 }];
  const r = await f.run();
  assert.equal(r.data.nombre_correspondances, 1);
  assert.equal(r.data.service_1_id, "2");
});
test("database rate changes apply without restarting worker", async () => {
  const f = fixture({}, { settings: [{ value: JSON.stringify({ peakerr: { XAF: 900 } }) }] });
  assert.equal(JSON.parse((await f.run()).data.service_1_prix).par_1000, 900);
  f.data.settings[0].value = JSON.stringify({ peakerr: { XAF: 1000 } });
  assert.equal(JSON.parse((await f.run()).data.service_1_prix).par_1000, 1000);
});
test("provider failure is explicit, not a fabricated empty catalogue", async () => {
  const r = await fixture({}, { fail: true }).run();
  assert.equal(r.status, "error");
  assert.equal(r.data.fournisseurs_indisponibles, 1);
});
test("incomplete provider coverage is labelled partial", async () => {
  const f = fixture({}, { providers: [{ provider_id: 4 }, { provider_id: 5 }] });
  const r = await catalogServices(f.ctx, async id => {
    if (id === 5) throw new Error("PRIVATE");
    return f.data.services;
  }, true, () => true);
  assert.equal(r.status, "ok");
  assert.equal(r.data.fournisseurs_indisponibles, 1);
  assert.match(r.data.statut, /partiel/);
});
test("invalid filters rejected before remote or financial operations", async () => {
  for (const fields of [{ sort: "secret" }, { provider_id: "2" }, { quantity: "0" },
    { page: "101" }, { days: "91" }, { budget_xaf: "100" }, { external_user_id: "other" }]) {
    const f = fixture(fields);
    await assert.rejects(async () => {
      const result = await f.run();
      if (result.status === "error") throw new Error("Rejected");
    });
    assert.equal(f.requests(), 0);
  }
});
test("new handlers require verified identity and mask DB/provider exceptions", async () => {
  let calls = 0;
  const handlers = createSabitoHandlers(async () => { calls++; throw new Error("PRIVATE"); });
  for (const operation of ["service_catalog", "service_recommendations"]) {
    assert.equal((await handlers[operation]({ external_user_id: "guest:1",
      expires_at: new Date(Date.now() + 60000).toISOString() })).status, "forbidden");
    const r = await handlers[operation]({ external_user_id: "member",
      expires_at: new Date(Date.now() + 60000).toISOString() });
    assert.deepEqual(r, { status: "error" });
  }
  assert.equal(calls, 2);
});
