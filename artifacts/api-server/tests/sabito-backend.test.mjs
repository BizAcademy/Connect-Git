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
const mockDatabase = {
  name: "no-real-database",
  setup(build) {
    build.onResolve({ filter: /\/mysql$/ }, () => ({ path: "mysql", namespace: "mock" }));
    build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
      contents: `export function getMysqlPool(){throw new Error("Live DB prohibited");}`,
    }));
  },
};
const define = {
  "process.env.SABITO_URL": JSON.stringify("https://sabito.example"),
  "process.env.SABITO_CLIENT_ID": JSON.stringify("test-id"),
  "process.env.SABITO_CLIENT_SECRET": JSON.stringify("test-secret"),
  "process.env.SMM_PANEL_4_API_URL": JSON.stringify("https://panel.example"),
  "process.env.SMM_PANEL_4_API_KEY": JSON.stringify("test-panel-key"),
};
await build({
  stdin: {
    contents: `export * from "./src/lib/sabito-handlers";
      export {answer} from "./src/lib/sabito-read";
      export {callProvider} from "./src/lib/smm-providers";
      export {startSabitoBackend} from "./src/vendor/sabito-backend.mjs";`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts",
  },
  outfile, bundle: true, platform: "node", format: "esm", packages: "external",
  logLevel: "silent", define, plugins: [mockDatabase],
});
const { createSabitoHandlers, SABITO_OPERATIONS, startSabitoBackend, answer, callProvider } = await import(pathToFileURL(outfile).href);
const job = (fields = {}, extra = {}) => ({
  external_user_id: "member-A", expires_at: new Date(Date.now() + 60000).toISOString(), fields, ...extra,
});
const now = "2026-10-19T12:00:00Z";
function fixtures() {
  return {
    user: { id: "member-A", disabled_at: null, email_verified_at: now },
    payments: [{
      id: "payment-A", user_id: "member-A", order_id: "DEP-A", reference: "REF-A",
      provider_reference: "provider-A", transaction_id: "TX-A", phone_number: "690000000",
      method: "mobile_money", country: "CM", status: "completed", credited_at: now,
      amount_minor: 500000, currency: "XAF", created_at: now, bonus_amount_minor: 20000,
      bonus_status: "credited", bonus_credited_at: now, wallet_credited: "local",
    }],
    orders: [{
      id: "order-A", user_id: "member-A", provider: 4, provider_order_id: "external-A",
      external_order_id: "external-A", service_name: "Instagram followers", service_category: "Instagram",
      quantity: 100, status: "processing", created_at: now, charge_minor: 1000, currency: "USD",
      refunded_at: null, refunded_amount_minor: null,
    }],
    movements: [{
      id: "movement-A", user_id: "member-A", reference_id: "payment-A", reference_type: "payment",
      type: "deposit", amount_minor: 520000, currency: "XAF", created_at: now,
    }],
    profiles: [{ user_id: "member-A", referral_code: "MYCODE", balance_minor: 92900, balance_usd_minor: 1234 }],
    referrals: [{
      id: "reward-A", referrer_user_id: "member-A", referred_user_id: "member-B", status: "paid",
      referrer_bonus_minor: 10000, referred_bonus_minor: 4000,
      referrer_credited_at: now, referred_credited_at: now, created_at: now,
    }],
    tickets: [],
  };
}
function setup(change = () => {}, provider = async () => ({ status: "In progress", remains: "60" })) {
  const data = fixtures();
  change(data);
  const calls = [];
  let providerCalls = 0;
  const query = async (sql, params, signal) => {
    signal?.throwIfAborted();
    assert.match(sql, /^SELECT\s/i);
    assert.ok(!sql.includes("SELECT *"));
    assert.ok(!/\b(UPDATE|DELETE|INSERT|CALL)\b/i.test(sql));
    calls.push({ sql, params });
    const owner = params[0];
    if (sql.includes("FROM users")) return data.user && data.user.id === owner ? [data.user] : [];
    assert.match(sql, /(?:user_id|referrer_user_id|referred_user_id)=\?/);
    if (sql.includes("FROM payments")) {
      let offset = 1;
      let rows = data.payments.filter(p => p.user_id === owner && p.method !== "admin_adjustment");
      for (const columns of [
        ["id", "order_id", "reference", "provider_reference"], ["transaction_id"],
        ["phone_number"], ["country"], ["method"],
      ]) {
        if (!sql.includes(`(${columns[0]}=?`)) continue;
        const value = params[offset]; offset += columns.length;
        rows = rows.filter(p => columns.some(column => p[column] === value));
      }
      return rows.slice(0, 2);
    }
    if (sql.includes("FROM orders")) return data.orders.filter(o => o.user_id === owner &&
      [o.id, o.provider_order_id, o.external_order_id].includes(params[1])).slice(0, 2);
    if (sql.includes("FROM profiles")) return data.profiles.filter(p => p.user_id === owner);
    if (sql.includes("FROM referrals")) {
      const referee = sql.includes("WHERE referred_user_id=?");
      const prefix = referee ? "referred" : "referrer";
      return data.referrals.filter(r => r[`${prefix}_user_id`] === owner && (!params[1] || r.id === params[1]))
        .slice(0, 2).map(r => ({ ...r, own_amount: r[`${prefix}_bonus_minor`], own_credited_at: r[`${prefix}_credited_at`] }));
    }
    if (sql.includes("FROM wallet_transactions")) {
      let rows = data.movements.filter(m => m.user_id === owner);
      if (sql.includes("(id=? OR reference_id=?)")) {
        rows = rows.filter(m => m.id === params[1] || m.reference_id === params[1]);
        if (params[3]) rows = rows.filter(m => m.type === params[3]);
      } else {
        rows = rows.filter(m => m.reference_id === params[1]);
        if (sql.includes("type='deposit'")) rows = rows.filter(m => m.type === "deposit");
        else if (sql.includes("type='refund'")) rows = rows.filter(m => m.type === "refund");
        else if (sql.includes("type IN")) rows = rows.filter(m => ["deposit", "deposit_bonus"].includes(m.type));
        else rows = rows.filter(m => m.type === params[2]);
      }
      return rows.slice(0, sql.includes("LIMIT 3") ? 3 : 2);
    }
    if (sql.includes("FROM tickets")) return data.tickets.filter(t => t.user_id === owner && t.status === "open" &&
      (t.order_local_id === params[1] || (!t.order_local_id && t.order_external_id === params[2] && String(t.provider_id) === params[3]))).slice(0, 2);
    throw new Error("Unexpected query");
  };
  const handlers = createSabitoHandlers(query, async (...args) => { providerCalls++; return provider(...args); });
  return { handlers, calls, data, providerCalls: () => providerCalls };
}
function flat(result) {
  if (!result.data) return;
  assert.ok(Object.keys(result.data).length <= 32);
  for (const value of Object.values(result.data)) {
    assert.ok(value === null || ["string", "number", "boolean"].includes(typeof value));
    if (typeof value === "number") assert.ok(Number.isFinite(value));
    if (typeof value === "string") assert.ok(value.length <= 2000);
  }
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
}

test("exactly nine implemented operations; no activation or fictitious withdrawals", () => {
  const { handlers } = setup();
  assert.deepEqual(Object.keys(handlers), [...SABITO_OPERATIONS]);
  assert.equal(handlers.account_activation, undefined);
  assert.equal(handlers.withdrawal_status, undefined);
});
test("mobile deposit exposes actual amount, currency and recorded credit, not a complete row", async () => {
  const { handlers } = setup(d => { d.payments[0].secret = "PRIVATE"; });
  const r = await handlers.deposit_status(job({ deposit_number: "DEP-A" }));
  assert.equal(r.status, "confirmed");
  assert.equal(r.data.montant, 5000);
  assert.equal(r.data.montant_credit_enregistre, 5200);
  assert.equal(r.data.devise, "XAF");
  flat(r);
});
test("crypto deposit uses actual persisted transaction reference and USD credit", async () => {
  const { handlers } = setup(d => {
    Object.assign(d.payments[0], { method: "crypto", provider: "izipay", amount_minor: 2500, currency: "USD", wallet_credited: "usd" });
    Object.assign(d.movements[0], { amount_minor: 2500, currency: "USD" });
  });
  const r = await handlers.deposit_status(job({ transaction_id: "TX-A" }));
  assert.equal(r.status, "confirmed");
  assert.equal(r.data.devise, "USD");
  assert.equal(r.data.montant_credit_enregistre, 25);
});
test("foreign, missing and contradictory deposit references reveal no payment", async () => {
  const { handlers } = setup(d => { d.payments.push({ ...d.payments[0], user_id: "member-B", order_id: "DEP-B" }); });
  for (const fields of [{ deposit_number: "DEP-B" }, { deposit_number: "missing" },
    { deposit_number: "DEP-A", transaction_id: "foreign" }]) {
    assert.equal((await handlers.deposit_status(job(fields))).status, "not_found");
  }
});
test("a phone number matching multiple owned deposits requires another reference", async () => {
  const { handlers } = setup(d => { d.payments.push({ ...d.payments[0], id: "payment-C", order_id: "DEP-C" }); });
  const r = await handlers.deposit_status(job({ phone_number: "690000000" }));
  assert.equal(r.status, "error");
  assert.match(r.data.statut, /référence supplémentaire/);
  assert.equal((await handlers.deposit_status(job({ phone_number: "690000000", deposit_number: "DEP-A" }))).status, "confirmed");
});
test("fields are parameterized, never normalized, and malformed references do not reach payments", async () => {
  const { handlers, calls } = setup();
  assert.equal((await handlers.deposit_status(job({ deposit_number: "' OR 1=1 --", country: "CM" }))).status, "not_found");
  assert.ok(calls.at(-1).params.includes("' OR 1=1 --"));
  assert.ok(!calls.at(-1).sql.includes("OR 1=1"));
  for (const fields of [{ deposit_number: " DEP-A " }, { transaction_id: "TX-A", payment_method: 1 }]) {
    const before = calls.length;
    assert.equal((await handlers.deposit_status(job(fields))).status, "error");
    assert.equal(calls.length, before + 1);
  }
});
test("pending, failed and irregular crypto states map explicitly; missing credit cannot be confirmed", async () => {
  for (const [state, expected] of [["pending", "pending"], ["failed", "failed"], ["irregular", "pending"], ["expired", "failed"]]) {
    const { handlers } = setup(d => { Object.assign(d.payments[0], { status: state, credited_at: null }); d.movements = []; });
    const r = await handlers.deposit_status(job({ deposit_number: "DEP-A" }));
    assert.equal(r.status, expected);
    assert.equal(r.data.statut, state);
  }
  const { handlers } = setup(d => { d.movements = []; });
  assert.equal((await handlers.deposit_status(job({ deposit_number: "DEP-A" }))).status, "error");
});
test("order read checks ownership before provider access and returns only real remaining quantity", async () => {
  const { handlers, providerCalls } = setup();
  assert.equal((await handlers.order_status(job({ order_number: "foreign" }))).status, "not_found");
  assert.equal(providerCalls(), 0);
  const r = await handlers.order_status(job({ order_number: "order-A" }));
  assert.equal(r.status, "pending");
  assert.equal(r.data.quantite_restante, 60);
  assert.equal(r.data.montant, 10);
  assert.equal(r.data.provider, undefined);
  assert.equal(r.data.provider_order_id, undefined);
  flat(r);
});
test("provider errors, unknown states and impossible remaining quantities never become fake progress", async () => {
  for (const response of [{ error: "PRIVATE" }, { status: "unknown" }, { status: "" },
    { status: "Processing", remains: true }, { status: "Processing", remains: 101 }]) {
    const { handlers } = setup(() => {}, async () => response);
    assert.deepEqual(await handlers.order_status(job({ order_number: "order-A" })), { status: "error" });
  }
  const { handlers } = setup(() => {}, async () => ({ status: "Completed" }));
  assert.equal((await handlers.order_status(job({ order_number: "order-A" }))).data.quantite_restante, null);
});
test("partial refund retains the recorded amount and demands an actual owned credit", async () => {
  const { handlers } = setup(d => {
    Object.assign(d.orders[0], { status: "partial", refunded_at: now, refunded_amount_minor: 300 });
    d.movements.push({ id: "refund-A", user_id: "member-A", reference_type: "order", reference_id: "order-A",
      type: "refund", amount_minor: 300, currency: "USD", created_at: now });
  });
  const r = await handlers.order_refund_status(job({ order_number: "order-A" }));
  assert.equal(r.status, "confirmed");
  assert.equal(r.data.montant, 3);
  assert.match(r.data.statut, /partiel/);
});
test("canceled orders and closed tickets are not proof of refund or refusal", async () => {
  const { handlers } = setup(d => { d.orders[0].status = "canceled"; });
  const r = await handlers.order_refund_status(job({ order_number: "order-A" }));
  assert.equal(r.status, "ok");
  assert.equal(r.data.statut, "Aucun remboursement enregistré");
});
test("open refund requests remain pending, without fabricated in-progress or refused states", async () => {
  const { handlers } = setup(d => { d.tickets.push({ user_id: "member-A", order_local_id: "order-A", status: "open", short_code: "T-A", created_at: now }); });
  const r = await handlers.order_refund_status(job({ order_number: "order-A" }));
  assert.equal(r.status, "pending");
  assert.equal(r.data.montant, 0);
  assert.equal(r.data.reference_demande, "T-A");
});
test("deposit bonus follows stored eligibility and requires a recorded financial movement", async () => {
  const { handlers } = setup();
  const r = await handlers.deposit_bonus_status(job({ deposit_number: "DEP-A" }));
  assert.equal(r.status, "confirmed");
  assert.equal(r.data.montant, 200);
  const absent = setup(d => { d.movements = []; });
  assert.equal((await absent.handlers.deposit_bonus_status(job({ deposit_number: "DEP-A" }))).status, "error");
});
test("an initial default bonus flag does not falsely reject an unconfirmed deposit", async () => {
  const f = setup(d => {
    Object.assign(d.payments[0], { status: "pending", credited_at: null, bonus_credited_at: null, bonus_status: "not_eligible", bonus_amount_minor: 0 });
    d.movements = [];
  });
  const r = await f.handlers.deposit_bonus_status(job({ deposit_number: "DEP-A" }));
  assert.equal(r.status, "pending");
  assert.equal(r.data.montant, null);
  assert.equal(r.data.etat_enregistre, "not_eligible");
});
test("local and USD balances stay distinct, with no conversion or fictitious total", async () => {
  const r = await setup().handlers.wallet_balance(job());
  assert.equal(r.data.solde_local, 929);
  assert.equal(r.data.devise_local, "XAF");
  assert.equal(r.data.solde_usd, 12.34);
  assert.equal(r.data.devise_usd, "USD");
  assert.equal(r.data.total, undefined);
});
test("referral code is read-only and never generated", async () => {
  assert.deepEqual(await setup().handlers.referral_code(job()), { status: "ok", data: { code: "MYCODE" } });
  const missing = setup(d => { d.profiles[0].referral_code = null; });
  assert.equal((await missing.handlers.referral_code(job())).status, "not_found");
});
test("own referral commission and referee bonus never expose the other member or their payment", async () => {
  for (const referee of [false, true]) {
    const f = setup(d => {
      if (referee) { d.referrals[0].referred_user_id = "member-A"; d.referrals[0].referrer_user_id = "PRIVATE"; }
      d.referrals[0].private_payment = "PRIVATE";
      d.movements.push({ id: "reward-movement", user_id: "member-A", reference_id: "reward-A", reference_type: "referral",
        type: referee ? "referral_referred_bonus" : "referral_referrer_bonus",
        amount_minor: referee ? 4000 : 10000, currency: "XOF", created_at: now });
    });
    const r = await f.handlers[referee ? "referee_bonus_status" : "referral_reward_status"](job());
    assert.equal(r.status, "confirmed");
    assert.equal(r.data.montant, referee ? 40 : 100);
    flat(r);
  }
});
test("multiple referral rewards require a reference, and missing credits are not confirmed", async () => {
  const f = setup(d => { d.referrals.push({ ...d.referrals[0], id: "reward-C" }); });
  assert.equal((await f.handlers.referral_reward_status(job())).status, "error");
  assert.equal((await f.handlers.referral_reward_status(job({ referral_number: "reward-A" }))).status, "error");
});
test("precise owned movements expose direction and an approved label, never staff notes", async () => {
  const f = setup(d => { Object.assign(d.movements[0], { type: "admin_adjustment", amount_minor: -500, note: "PRIVATE", actor: "PRIVATE" }); });
  const r = await f.handlers.wallet_movement_status(job({ movement_number: "movement-A" }));
  assert.equal(r.status, "confirmed");
  assert.equal(r.data.sens, "débit");
  assert.equal(r.data.montant, 5);
  flat(r);
  assert.equal((await f.handlers.wallet_movement_status(job({ movement_number: "foreign" }))).status, "not_found");
});
test("all operations reject revoked business access, invalid identities and database errors without writes", async () => {
  for (const user of [null, { id: "member-A", disabled_at: now }, { id: "member-A", disabled_at: null, email_verified_at: null }]) {
    const f = setup(d => { d.user = user; });
    for (const handler of Object.values(f.handlers)) {
      assert.equal((await handler(job())).status, user ? "forbidden" : "not_found");
    }
    assert.ok(f.calls.every(c => c.sql.includes("FROM users")));
  }
  const handlers = createSabitoHandlers(async () => { throw new Error("PRIVATE"); });
  for (const handler of Object.values(handlers)) assert.deepEqual(await handler(job()), { status: "error" });
  const f = setup();
  for (const extra of [{ external_user_id: "guest:123" }, { expires_at: "invalid" }, { signal: AbortSignal.abort() }]) {
    await f.handlers.wallet_balance(job({}, extra));
    assert.equal(f.calls.length, 0);
  }
});
test("deadlines and cancellation during reads discard results", async () => {
  const controller = new AbortController();
  const handlers = createSabitoHandlers(async () => { controller.abort(); return [fixtures().user]; });
  assert.equal((await handlers.wallet_balance(job({}, { signal: controller.signal }))).status, "error");
  const stuck = createSabitoHandlers(async () => new Promise(() => {}));
  assert.equal((await stuck.wallet_balance(job({}, { expires_at: new Date(Date.now() + 30).toISOString() }))).status, "error");
});
test("result contract rejects nested objects, nonfinite numbers and oversized responses", () => {
  for (const data of [{ bad: [] }, { bad: {} }, { bad: Infinity }, { bad: "x".repeat(2001) },
    Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`key${n}`, n]))]) {
    assert.throws(() => answer("ok", "test", data));
  }
});
test("SMM status transport is bounded and refuses redirects and non-success HTTP responses", async () => {
  const originalFetch = globalThis.fetch;
  let failed = false;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://panel.example");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    const form = new URLSearchParams(init.body);
    assert.equal(form.get("action"), "status");
    assert.equal(form.get("order"), "external-A");
    return failed ? Response.json({ status: "Completed", sensitive: "PRIVATE" }, { status: 500 })
      : Response.json({ status: "Processing", remains: "3" });
  };
  try {
    assert.equal((await callProvider(4, "status", { order: "external-A" }, {})).remains, "3");
    failed = true;
    await assert.rejects(callProvider(4, "status", { order: "external-A" }, {}), /PROVIDER_STATUS_UNAVAILABLE/);
  } finally { globalThis.fetch = originalFetch; }
});
test("official SDK advertises only actual operations and submits flat authorized data", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const { handlers } = setup();
  let submitted = false;
  globalThis.fetch = async (url, init) => {
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from("test-id:test-secret").toString("base64")}`);
    assert.equal(init.headers.Origin, undefined);
    assert.equal(init.redirect, "error");
    if (String(url).endsWith("/jobs/poll")) {
      assert.deepEqual(JSON.parse(init.body).operations, [...SABITO_OPERATIONS]);
      return Response.json({ jobs: [{ ...job(), id: "12345678-1234-1234-1234-123456789abc", operation: "wallet_balance" }] });
    }
    const body = JSON.parse(init.body);
    assert.equal(body.result.data.solde_usd, 12.34);
    flat(body.result);
    submitted = true;
    controller.abort();
    return Response.json({ ok: true });
  };
  try {
    await startSabitoBackend({ handlers, signal: controller.signal, onError: code => assert.fail(code) });
    assert.ok(submitted);
  } finally { controller.abort(); globalThis.fetch = originalFetch; }
});
test("database failure releases worker IPC for supervisor restart without claiming jobs", async () => {
  const workerFile = path.join(dir, "worker-failure.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/scripts/sabito-worker.ts", import.meta.url))],
    outfile: workerFile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent", define,
    plugins: [{
      name: "database-unreachable",
      setup(build) {
        build.onResolve({ filter: /\/mysql$/ }, () => ({ path: "mysql", namespace: "mock" }));
        build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
          contents: `export function getMysqlPool(){return {async getConnection(){
            const e=new Error("PRIVATE");e.code="ECONNREFUSED";throw e;
          }}};export async function closeMysqlPool(){}`,
        }));
      },
    }],
  });
  const child = fork(workerFile, [], { env: { NODE_ENV: "test" }, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages = [];
  let output = "";
  child.on("message", m => messages.push(m));
  child.stdout.on("data", d => { output += d; }); child.stderr.on("data", d => { output += d; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    const [code, signal] = await new Promise(resolve => child.once("exit", (...args) => resolve(args)));
    assert.equal(signal, null); assert.equal(code, 1); assert.equal(output, "");
    assert.deepEqual(messages, [{ type: "sabito", event: "fatal", code: "ECONNREFUSED" }]);
  } finally { clearTimeout(timeout); child.kill("SIGKILL"); }
});
