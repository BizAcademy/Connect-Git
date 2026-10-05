import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";

const outdir = fileURLToPath(new URL("../dist/afribapay-fees-test/", import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/afribapay-fees.ts", import.meta.url))],
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const {
  extractAfribapayProviderFees,
  extractAfribapayProviderPreview,
  feeReconciliationRetryAfterSeconds,
} = await import(pathToFileURL(`${outdir}/afribapay-fees.mjs`).href);

test("reads provider fees and taxes from a nested AfribaPAY response", () => {
  assert.deepEqual(
    extractAfribapayProviderFees({ data: { fees: "25", taxes: 5, fees_taxes_ttc: "30" } }),
    { fees: 25, taxes: 5, total: 30 },
  );
});

test("derives a total only when both fee and tax amounts are present", () => {
  assert.deepEqual(
    extractAfribapayProviderFees({ fees: 20, taxes: 3 }),
    { fees: 20, taxes: 3, total: 23 },
  );
  assert.deepEqual(
    extractAfribapayProviderFees({ fees: 20 }),
    { fees: 20, taxes: null, total: null },
  );
});

test("does not infer fees when the provider response has none or invalid values", () => {
  assert.equal(extractAfribapayProviderFees({ fees: "unknown", taxes: -1 }), null);
  assert.equal(extractAfribapayProviderFees({ data: { status: "SUCCESS" } }), null);
});

test("combines exact fee and tax fields spread across nested provider data", () => {
  assert.deepEqual(
    extractAfribapayProviderFees({ fees: 2, data: { taxes: 1 } }),
    { fees: 2, taxes: 1, total: 3 },
  );
});

test("backs off automatic fee lookups when values or provider responses are missing", () => {
  assert.equal(feeReconciliationRetryAfterSeconds(1, "missing"), 3_600);
  assert.equal(feeReconciliationRetryAfterSeconds(2, "missing"), 21_600);
  assert.equal(feeReconciliationRetryAfterSeconds(99, "missing"), 2_592_000);
  assert.equal(feeReconciliationRetryAfterSeconds(1, "error"), 900);
  assert.equal(feeReconciliationRetryAfterSeconds(99, "error"), 604_800);
});

test("provider preview returns only amount fields from the documented status response", () => {
  assert.deepEqual(
    extractAfribapayProviderPreview({
      request_id: "not returned",
      data: {
        transaction_id: "not returned",
        order_id: "not returned",
        phone_number: "not returned",
        amount: "100",
        fees: 2,
        taxes: 1,
        fees_taxes_ttc: 3,
        amount_total: 103,
        currency: "xaf",
      },
    }),
    {
      amount: 100,
      fees: 2,
      taxes: 1,
      fees_taxes_ttc: 3,
      amount_total: 103,
      currency: "XAF",
    },
  );
});

test("provider preview keeps missing or invalid amount fields unknown", () => {
  assert.deepEqual(
    extractAfribapayProviderPreview({ data: { status: "SUCCESS", fees: "unknown", taxes: -1 } }),
    {
      amount: null,
      fees: null,
      taxes: null,
      fees_taxes_ttc: null,
      amount_total: null,
      currency: null,
    },
  );
});

test("provider preview can read fields spread across nested response objects", () => {
  assert.deepEqual(
    extractAfribapayProviderPreview({
      currency: "XAF",
      amount: 500,
      data: {
        fees: 12,
        taxes: 2,
        fees_taxes_ttc: 14,
        amount_total: 514,
      },
    }),
    {
      amount: 500,
      fees: 12,
      taxes: 2,
      fees_taxes_ttc: 14,
      amount_total: 514,
      currency: "XAF",
    },
  );
});