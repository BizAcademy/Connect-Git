import assert from "node:assert/strict";
import { test, after } from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = await mkdtemp(path.join(tmpdir(), "bb-afribapay-"));
const root = fileURLToPath(new URL("..", import.meta.url));
const bundle = path.join(directory, "test.mjs");
await build({
  stdin: {
    contents: `export * from "./src/lib/afribapay";
      export * from "../bizpanel/src/lib/deposit-checkout";`,
    resolveDir: root, loader: "ts",
  },
  outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external",
  logLevel: "silent",
  define: {
    "process.env.AFRIBAPAY_API_USER": JSON.stringify("test-user"),
    "process.env.AFRIBAPAY_API_KEY": JSON.stringify("test-api-key"),
    "process.env.AFRIBAPAY_MERCHANT_KEY": JSON.stringify("test-merchant"),
    "process.env.AFRIBAPAY_API_BASE": JSON.stringify("https://afribapay.example"),
  },
  plugins: [{
    name: "isolated-logger",
    setup(b) {
      b.onResolve({ filter: /^\.\/logger$/ }, () => ({ path: "logger", namespace: "mock" }));
      b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
        contents: "export const logger={info(){},warn(){},error(){}};", loader: "js",
      }));
    },
  }],
});
const api = await import(pathToFileURL(bundle).href);
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); });

function provider(response) {
  const calls = [];
  api.resetTokenState();
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/v1/token") return Response.json({ data: { access_token: "test-token", expires_in: 3600 } });
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return Response.json(response);
  };
  return calls;
}
const params = {
  country: "CI", operator: "wave", phone_number: "0700000000",
  amount: 1020, currency: "XOF", order_id: "BUZZ_CM_EXAMPLE", notify_url: "https://merchant.example/api/payments/webhook",
};

test("Wave reads official provider_link and forwards merchant return/cancel URLs", async () => {
  const calls = provider({ data: {
    transaction_id: "PIM261012174643113285128", order_id: params.order_id, status: "PENDING",
    provider_link: "https://pay.wave.com/c/test?a=1020&c=XOF",
  } });
  const result = await api.payin({
    ...params, return_url: "https://merchant.example/dashboard/deposit",
    cancel_url: "https://merchant.example/dashboard/deposit",
  });
  assert.equal(result.redirect_url, "https://pay.wave.com/c/test?a=1020&c=XOF");
  assert.equal(result.transaction_id, "PIM261012174643113285128");
  assert.equal(calls[0].body.order_id, params.order_id);
  assert.equal(calls[0].body.return_url, "https://merchant.example/dashboard/deposit");
  assert.equal(calls[0].body.cancel_url, calls[0].body.return_url);
  assert.equal(calls[0].body.lang, "fr");
});

test("Djamo provider_link and payment_link are supported", async () => {
  for (const field of ["provider_link", "payment_link"]) {
    provider({ data: { status: "PENDING", [field]: "https://p.djamo.com/payment-link/?chargeId=test" } });
    const result = await api.payin({ ...params, operator: "djamo" });
    assert.equal(result.redirect_url, "https://p.djamo.com/payment-link/?chargeId=test");
  }
});

test("unsafe checkout URLs cannot be returned or restored in frontend", () => {
  for (const value of ["javascript:alert(1)", "http://pay.wave.com/test", "https://user:password@pay.wave.com", "wave://test", null, {}]) {
    assert.equal(api.safeCheckoutUrl(value), undefined);
    assert.equal(api.checkoutUrl(value), null);
  }
  assert.equal(api.checkoutUrl("https://pay.wave.com/c/test"), "https://pay.wave.com/c/test");
});

test("status queries use exactly one correctly named identifier", async () => {
  for (const [id, field] of [["BUZZ_CM_1792041159_EXAMPLE", "order_id"], ["PIM261012174643113285128", "transaction_id"], ["POM261012174643113285128", "transaction_id"]]) {
    const calls = provider({ data: { status: "PENDING", [field]: id } });
    await api.getStatus(id);
    assert.deepEqual([...calls[0].url.searchParams.entries()], [[field, id]]);
  }
});

test("saved AfribaPAY transaction ID takes priority over merchant order ID", async () => {
  const calls = provider({ data: { status: "SUCCESS", transaction_id: "PIM261012174643", order_id: params.order_id } });
  const status = await api.getPaymentStatus({ order_id: params.order_id, transaction_id: "PIM261012174643" });
  assert.equal(status.status, "SUCCESS");
  assert.equal(calls[0].url.search, "?transaction_id=PIM261012174643");
});

test("legacy rows use order_id without ever relabeling BUZZ as transaction_id", async () => {
  const calls = provider({ data: { status: "PENDING", order_id: params.order_id } });
  await api.getPaymentStatus({ order_id: params.order_id, transaction_id: params.order_id });
  assert.equal(calls[0].url.search, `?order_id=${params.order_id}`);
  await assert.rejects(api.getStatus(params.order_id, "transaction_id"), /invalide/);
});

test("mismatched provider references are rejected before crediting", async () => {
  provider({ data: { status: "SUCCESS", order_id: "another-member-order", transaction_id: "PIM261012174643" } });
  await assert.rejects(api.getPaymentStatus({ order_id: params.order_id, transaction_id: "PIM261012174643" }), /incohérentes/);
});

test("only documented SUCCESS/FAILED are final; PENDING/OK/APPROVED never credit", () => {
  assert.equal(api.isSuccessStatus("SUCCESS"), true);
  assert.equal(api.isFailureStatus("FAILED"), true);
  for (const value of ["PENDING", "OK", "APPROVED", "ERROR", null, ""]) {
    assert.equal(api.isSuccessStatus(value), false);
    assert.equal(api.isFailureStatus(value), false);
  }
});

test("new documented CI/BF methods are merged without duplicates", () => {
  const countries = api.normalizeCountries({ data: {
    CI: { country_name: "Côte d’Ivoire", currencies: { XOF: { operators: [{ operator_code: "wave", operator_name: "Wave" }] } } },
    BF: { country_name: "Burkina Faso", currencies: { XOF: { operators: [{ operator_code: "orange", otp_required: 1 }] } } },
  } });
  assert.deepEqual(countries[0].operators.map(x => x.code), ["wave", "djamo"]);
  assert.deepEqual(countries[1].operators.map(x => x.code), ["orange", "wave", "wligdicash"]);
  assert.equal(countries[1].operators.find(x => x.code === "wligdicash").otp_required, true);
  assert.ok(countries.flatMap(c => c.operators).every(o => o.currency === "XOF"));
});

test("explicit provider outages and PAYOUT-only methods are never re-enabled by supplements", () => {
  const result = api.normalizeCountries({ data: [{ code: "BF", currency: "XOF", operators: [
    { code: "wave", enabled: false }, { code: "wligdicash", payin: false }, { code: "orange" },
  ] }] });
  assert.deepEqual(result[0].operators.map(x => x.code), ["orange"]);
  assert.deepEqual(api.normalizeCountries({ data: [{ code: "CI", enabled: false, operators: [] }] }), []);
});

test("wallet OTP sends amount, currency, merchant key and exact operator code", async () => {
  const calls = provider({ data: { status: "PENDING" } });
  await api.requestOtp({ country: "BF", operator: "wligdicash", phone_number: "04090000", amount: 1020, currency: "XOF" });
  assert.equal(calls[0].url.pathname, "/v1/pay/otp");
  assert.deepEqual(calls[0].body, {
    country: "BF", operator: "wligdicash", phone_number: "04090000",
    amount: 1020, currency: "XOF", merchant_key: "test-merchant",
  });
});

test("restoring checkout preserves reference, not a paid status, and is member-scoped", () => {
  const pending = {
    orderId: params.order_id, amount: 1000, redirectUrl: "https://pay.wave.com/c/test",
    country: { code: "CI", name: "Côte d’Ivoire", operators: [] },
    operator: { code: "wave", name: "Wave", otp_required: false },
  };
  assert.equal(api.restoreCheckout(JSON.stringify(pending)).orderId, params.order_id);
  assert.equal(api.restoreCheckout("invalid"), null);
  assert.equal(api.restoreCheckout(JSON.stringify({ ...pending, orderId: "" })), null);
  assert.notEqual(api.checkoutKey("member-A"), api.checkoutKey("member-B"));
});

test("scanner never marks a provider PENDING payment failed because of elapsed time", async () => {
  const scanner = await readFile(path.join(root, "src/lib/pending-payment-scanner.ts"), "utf8");
  const source = scanner.slice(scanner.indexOf("async function reconcileOne"), scanner.indexOf("async function scanOnce"));
  assert.equal((source.match(/markPaymentStatus\(p\.id, "failed"\)/g) || []).length, 1);
  assert.ok(source.includes("if (isFailureStatus(remote.status))"));
  assert.ok(source.includes("getPaymentStatus(current)"));
  assert.equal(source.includes("ageMs >"), false);
});

// Execute the real route with isolated services: no database or live provider.
const routeBundle = path.join(directory, "routes.mjs");
const mocks = {
  express: `export const Router=()=>({
    get(){}, post(path,...handlers){ if(path==='/payments/initiate') globalThis.__initiate=handlers.at(-1); }
  });`,
  "../lib/logger": "export const logger={info(){},warn(){},error(){}};",
  "../lib/auth": "export const requireUser=(_req,_res,next)=>next();",
  "../lib/operator-logos": "export const fetchOperatorLogos=async()=>({}); export const operatorLogoPath=()=>null;",
  "../lib/deposits": `
    export const creditDeposit=async()=>{throw Error('Unexpected credit during initiation');};
    export const markPaymentStatus=async(id,status)=>globalThis.__marks.push(status);
    export const updatePaymentTransaction=async()=>{};
    export const recordAfribapayProviderFees=async()=>{};
    export const fetchPayment=async()=>null, fetchPaymentByOrderId=async()=>null;
    export const createPayment=async()=> 'fixture-payment';
    export const BONUS_THRESHOLD_FCFA=5000, BONUS_AMOUNT_FCFA=200;
    export const isEligibleForBonus=()=>false;`,
  "../lib/afribapay": `
    export class AfribapayApiError extends Error {
      constructor(status,payload,message){super(message||'Provider error');this.status=status;this.payload=payload;}
    }
    export class AfribapayNotConfiguredError extends Error {}
    export const isAfribapayConfigured=()=>true, isCountryExcluded=()=>false;
    export const listAllowedCountries=async()=>[{code:'CI',currency:'XOF',operators:[{code:'wave',currency:'XOF',otp_required:false}]}];
    export const payin=async(params)=>{
      globalThis.__payinParams=params;
      if(globalThis.__failure===403) throw new AfribapayApiError(403,{error:{message:'Access forbidden'}});
      if(globalThis.__failure) throw new Error('Network unavailable');
      return {status:globalThis.__providerStatus||'PENDING',transaction_id:'PIM261101000000',redirect_url:'https://pay.wave.com/c/test'};
    };
    export const requestOtp=async()=>{}, getPaymentStatus=async()=>{};
    export const verifyWebhookSignature=()=>false;
    export const isSuccessStatus=s=>s==='SUCCESS', isFailureStatus=s=>s==='FAILED';
    export const resetTokenState=()=>{}, getTokenDiagnostics=()=>({});`,
};
await build({
  entryPoints: [path.join(root, "src/routes/payments.ts")],
  outfile: routeBundle, bundle: true, platform: "node", format: "esm", logLevel: "silent",
  define: { "process.env.PUBLIC_API_URL": JSON.stringify("https://merchant.example") },
  plugins: [{
    name: "isolated-route",
    setup(b) {
      b.onResolve({ filter: /^(express|\.\.\/lib\/(logger|auth|deposits|afribapay|operator-logos))$/ },
        args => ({ path: args.path, namespace: "route-mock" }));
      b.onLoad({ filter: /.*/, namespace: "route-mock" },
        args => ({ contents: mocks[args.path], loader: "js" }));
    },
  }],
});
await import(pathToFileURL(routeBundle).href);
async function initiateRoute(failure, providerStatus = "PENDING") {
  globalThis.__failure = failure;
  globalThis.__providerStatus = providerStatus;
  globalThis.__marks = [];
  const response = { code: 200, body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await globalThis.__initiate({
    userId: "fixture-member", body: { amount: 1000, country: "CI", operator: "wave", phone_number: "0700000000" },
  }, response);
  return response;
}

test("real initiate route forwards checkout and callback fields without crediting", async () => {
  const response = await initiateRoute(null);
  assert.equal(response.code, 200);
  assert.equal(response.body.payment_redirect_url, "https://pay.wave.com/c/test");
  assert.equal(response.body.transaction_id, "PIM261101000000");
  assert.equal(globalThis.__payinParams.amount, 1020);
  const returned = new URL(globalThis.__payinParams.return_url);
  assert.equal(returned.origin, "https://merchant.example");
  assert.equal(returned.searchParams.get("payment"), response.body.order_id);
  assert.deepEqual(globalThis.__marks, []);
});

test("ambiguous initiate failure preserves pending reference instead of requesting a second charge", async () => {
  const response = await initiateRoute("network");
  assert.equal(response.code, 202);
  assert.equal(response.body.status, "UNKNOWN");
  assert.ok(response.body.order_id);
  assert.equal(response.body.payment_id, "fixture-payment");
  assert.deepEqual(globalThis.__marks, []);
});

test("explicit initiation rejection and provider FAILED are recorded as failures", async () => {
  assert.equal((await initiateRoute(403)).code, 400);
  assert.deepEqual(globalThis.__marks, ["failed"]);
  assert.equal((await initiateRoute(null, "FAILED")).body.status, "FAILED");
  assert.deepEqual(globalThis.__marks, ["failed"]);
});
