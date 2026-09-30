import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument as PdfReader } from "pdf-lib";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";

const outfile = fileURLToPath(new URL("../dist/deposit-invoice-test.mjs", import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/deposit-invoice.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent",
});
const { createDepositInvoiceAttachment } = await import(pathToFileURL(outfile).href);

test("creates a readable one-page PDF receipt suitable for a frozen email attachment", async () => {
  const attachment = await createDepositInvoiceAttachment({
    id: "12345678-1234-1234-1234-123456789012",
    createdAt: "2026-09-30T08:30:00.000Z",
    customerName: "Élodie Client",
    customerEmail: "client@example.test",
    method: "afribapay",
    reference: "deposit-ref-123",
    transactionId: "provider-tx-456",
    orderId: "order-789",
    depositedAmount: 6_000,
    depositedCurrency: "XAF",
    creditedAmount: 6_200,
    creditedCurrency: "FCFA",
    bonusAmount: 200,
  });

  assert.equal(attachment.filename, "facture-depot-BP-DEP-12345678.pdf");
  assert.equal(attachment.type, "application/pdf");
  const bytes = Buffer.from(attachment.content, "base64");
  assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-");
  const parsed = await PdfReader.load(bytes);
  assert.equal(parsed.getPageCount(), 1);
  assert.equal(parsed.getTitle(), "BP-DEP-12345678");
});