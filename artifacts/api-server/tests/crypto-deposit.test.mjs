import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const outfile = fileURLToPath(new URL("../dist/crypto-deposit-test.mjs", import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/izipay.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  logLevel: "silent",
});
const { quoteCryptoDeposit, storedCryptoCharge, createIntent } = await import(pathToFileURL(outfile).href);

test("a 100 USD deposit charges 101.50 USD and credits 100 USD", () => {
  assert.deepEqual(quoteCryptoDeposit(10_000), { feeMinor: 150, chargeMinor: 10_150 });
  assert.equal(storedCryptoCharge(10_000, 150, 10_150), 10_150);
});

test("the 1.5% fee is rounded to cents", () => {
  assert.deepEqual(quoteCryptoDeposit(100), { feeMinor: 2, chargeMinor: 102 });
  assert.deepEqual(quoteCryptoDeposit(134), { feeMinor: 2, chargeMinor: 136 });
});

test("old unpaid intents retain their original amount; inconsistent amounts fail", () => {
  assert.equal(storedCryptoCharge(10_000, 0, null), 10_000);
  assert.throws(() => storedCryptoCharge(10_000, 150, null));
  assert.throws(() => storedCryptoCharge(10_000, 150, 10_000));
});

test("IziChange Pay receives the total amount, not the credited amount", async () => {
  process.env.IZIPAY_API_KEY = "sk_test_fake";
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ id: "test-intent" }) };
  };
  try {
    await createIntent(quoteCryptoDeposit(10_000).chargeMinor, "test-ref", "https://example.com/return", "");
    assert.equal(body.amountRequested, "101.50");
    assert.equal(body.currencyRequested, "USD");
  } finally {
    globalThis.fetch = originalFetch;
  }
});