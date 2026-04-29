/**
 * Regression checks for OCR vs LLM reconciliation (no QVAC — runs in CI / locally with tsx).
 */
import assert from "node:assert/strict";
import { reconcileExtractedReceipt, shouldOcrOverrideLlmTotal } from "../server/receiptReconcile.js";
import type { ReceiptExtraction } from "../server/schema.js";

function x(
  merchant: string,
  total: number,
  currency: string,
  category = "retail"
): ReceiptExtraction {
  return { merchant, total, currency, category };
}

const greekBazaarOcr = `
BAZAAR A.E.
ΕΔΡΑ: ΠΕΙΡΑΙΩΣ
ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ
LOVITA 1.49
ΜΕΡΙΚΟ ΣΥΝΟΛΟ
7.23
ΣΥΝΟΛΟ
7.23
ΜΕΤΡΗΤΑ 10.00
ΡΕΣΤΑ 2.77
UID:0DBE2094
Auth code:BDE1E6
`.trim();

const greekSpacedTotalOcr = `
BAZAAR A.E.
ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ
ΜΕΡΙΚΟ ΣΥΝΟΛΟ
7 23
ΣΥΝΟΛΟ
7,23
ΜΕΤΡΗΤΑ 10,00
ΡΕΣΤΑ 2,77
UID:815400001294
Auth code:BD81E623
`.trim();

const greekTotalPaid615Ocr = `
MINI MARKET A.E.
ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ
NET 5,30
VAT 0,85
GROSS 6,15
TOTAL PAID 6,15
Cash 6,15
ΣΥΝΟΛΟ 6,15
UID: 815400001294
Auth code: 8D154AA2
`.trim();

// US: trust LLM when close to OCR
assert.equal(shouldOcrOverrideLlmTotal(12.99, 12.99), false);
assert.equal(shouldOcrOverrideLlmTotal(12.99, 13.1), false);
// Greek hallucination vs slip
assert.equal(shouldOcrOverrideLlmTotal(8154, 7.23), true);
// Tiny hallucination vs OCR total should also override.
assert.equal(shouldOcrOverrideLlmTotal(0.02, 33.9), true);

let out = reconcileExtractedReceipt(
  x("e ir7 UA noise UID", 8154, "EUR"),
  greekBazaarOcr
);
assert.ok(Math.abs(out.total - 7.23) < 0.01, `expected ~7.23, got ${out.total}`);
assert.ok(!/UID/i.test(out.merchant), `merchant should avoid footer: ${out.merchant}`);

out = reconcileExtractedReceipt(x("Target", 47.82, "USD"), "Receipt Total\n47.82\nThank you");
assert.ok(Math.abs(out.total - 47.82) < 0.01);

out = reconcileExtractedReceipt(x("Bazaar", 8154, "USD"), greekSpacedTotalOcr);
assert.ok(Math.abs(out.total - 7.23) < 0.01, `expected spaced OCR total 7.23, got ${out.total}`);
assert.equal(out.currency, "EUR");

out = reconcileExtractedReceipt(x("Mini Market", 8154, "USD"), greekTotalPaid615Ocr);
assert.ok(Math.abs(out.total - 6.15) < 0.01, `expected total-paid OCR total 6.15, got ${out.total}`);
assert.equal(out.currency, "EUR");

const myrReceiptOcr = `
ABC STORES SDN BHD
Tax Invoice
TOTAL RM 33.90
Cash 40.00
`.trim();
out = reconcileExtractedReceipt(x("ABC", 0.02, "USD"), myrReceiptOcr);
assert.equal(out.currency, "MYR");
assert.ok(Math.abs(out.total - 33.9) < 0.01, `expected MYR total 33.9, got ${out.total}`);

console.log("receipt reconcile tests: OK");
