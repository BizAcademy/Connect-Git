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
const { extractAfribapayProviderFees } = await import(pathToFileURL(`${outdir}/afribapay-fees.mjs`).href);

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