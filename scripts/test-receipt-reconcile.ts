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

// US: trust LLM when close to OCR
assert.equal(shouldOcrOverrideLlmTotal(12.99, 12.99), false);
assert.equal(shouldOcrOverrideLlmTotal(12.99, 13.1), false);
// Greek hallucination vs slip
assert.equal(shouldOcrOverrideLlmTotal(8154, 7.23), true);

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

console.log("receipt reconcile tests: OK");
