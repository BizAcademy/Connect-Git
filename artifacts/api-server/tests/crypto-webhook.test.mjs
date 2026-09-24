import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const outdir = fileURLToPath(new URL("../dist/crypto-webhook-tests/", import.meta.url));
await build({
  entryPoints: [
    fileURLToPath(new URL("../src/lib/crypto-deposit-scanner.ts", import.meta.url)),
    fileURLToPath(new URL("../src/lib/izipay.ts", import.meta.url)),
  ],
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  logLevel: "silent",
});
const { scanCryptoDepositsOnce } = await import(pathToFileURL(`${outdir}/crypto-deposit-scanner.mjs`).href);
const { retrieveIntent, verifyIzipayWebhook } = await import(pathToFileURL(`${outdir}/izipay.mjs`).href);

test("only correctly signed webhook bodies are accepted", () => {
  process.env.IZIPAY_WEBHOOK_SECRET = "local-test-secret";
  const raw = JSON.stringify({
    event: "payment_intent.completed",
    timestamp: Math.floor(Date.now() / 1000),
    data: { intentId: "pi_test" },
  });
  const signature = `sha256=${crypto.createHmac("sha256", "local-test-secret").update(raw).digest("hex")}`;
  const verified = verifyIzipayWebhook(raw, signature);
  assert.equal(verified.data.intentId, "pi_test");
  assert.equal(verified.stale, false);
  assert.throws(() => verifyIzipayWebhook(raw, "sha256=" + "0".repeat(64)));
});

test("an old, correctly signed retry is recognized without immediate processing", () => {
  process.env.IZIPAY_WEBHOOK_SECRET = "local-test-secret";
  const raw = JSON.stringify({
    event: "payment_intent.completed",
    timestamp: Math.floor(Date.now() / 1000) - 24 * 60 * 60,
    data: { intentId: "pi_old" },
  });
  const signature = `sha256=${crypto.createHmac("sha256", "local-test-secret").update(raw).digest("hex")}`;
  assert.equal(verifyIzipayWebhook(raw, signature).stale, true);
});

test("provider rate limits delay later intent lookups", async () => {
  process.env.IZIPAY_API_KEY = "sk_test_fake";
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return attempts === 1
      ? { ok: false, status: 429, headers: new Headers({ "Retry-After": "2" }) }
      : { ok: true, json: async () => ({ id: "pi_test" }) };
  };
  try {
    await assert.rejects(retrieveIntent("pi_test"), /429/);
    const start = Date.now();
    await retrieveIntent("pi_test");
    assert.equal(attempts, 2);
    assert.ok(Date.now() - start >= 1_800);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed reconciliation remains eligible for the next scan", async () => {
  const list = async (_kind, afterId) => afterId ? [] : [{ id: "payment-a" }];
  let attempts = 0;
  const reconcile = async () => {
    attempts++;
    if (attempts === 1) throw new Error("provider temporarily unavailable");
    return "completed";
  };
  const first = await scanCryptoDepositsOnce("pending", null, list, reconcile);
  assert.equal(first.errors, 1);
  const second = await scanCryptoDepositsOnce("pending", first.nextId, list, reconcile);
  assert.equal(second.errors, 0);
  assert.equal(second.checked, 1);
  assert.equal(attempts, 2);
});

test("the scan cursor rotates through the payment backlog", async () => {
  const ids = ["payment-a", "payment-b"];
  const list = async (_kind, afterId) => ids.filter(id => id > afterId).slice(0, 1).map(id => ({ id }));
  const checked = [];
  const reconcile = async id => { checked.push(id); return "pending"; };
  let cursor = null;
  for (let i = 0; i < 3; i++) {
    const result = await scanCryptoDepositsOnce("pending", cursor, list, reconcile);
    cursor = result.nextId;
  }
  assert.deepEqual(checked, ["payment-a", "payment-b", "payment-a"]);
});