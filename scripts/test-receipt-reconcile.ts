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

const greekNoisyFooterOcr = `
BAZAAR A.E
ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ
LOVITA 1,49
FARMER ΕΛΑΤΑ ΠΟΛΙΤΙΚΗ 300G 3,99 13*
ΜΕΡΙΚΟ ΣΥΝΟΛΟ 7,23
ΣΥΝΟΛΟ 7 23
ΜΕΤΡΗΤΑ 10,00
ΡΕΣΤΑ 2,77
TEMAXIA
ZEIPA: 0003-2-95-T032 01341238 27-04-2026 13;17,42 00030002
UID:8DBE2094888D765131C915854920
AUTH CODE:BDB11E646D277CB46CE3483E5E56952449E29F12B
EPSILON NET A.E
`.trim();

const greekMergedTotalCashLineOcr = `
BAZAAR A.E.
ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ
LOVITA 1,49 FARMER ΕΛΑΤΑ 300G 3,99 13*
ΜΕΡΙΚΟ ΣΥΝΟΛΟ 7,23 ΣΥΝΟΛΟ 7 23 ΜΕΤΡΗΤΑ 10,00 ΡΕΣΤΑ 2,77
UID:8DBE2094888D765131C915854920
AUTH CODE:BDB11E646D277CB46CE3483E5E56952449E29F12B
`.trim();

const greekSingleLineBeforeTotalOcr = `
BAZAAR A.E.
LOVITA 1,49 FARMER ΕΛΑΤΑ 300G 3,99 13* ΜΕΡΙΚΟ ΣΥΝΟΛΟ 7,23 ΣΥΝΟΛΟ 7 23 ΜΕΤΡΗΤΑ 10,00 ΡΕΣΤΑ 2,77
UID:8DBE2094888D765131C915854920
`.trim();

const greekNoisyRealSampleOcr = `
BazAar A.E. EAPA: MEIPAIQZ 8 MOIXATO YnOK /TIA : OkHPOY' 16 K.EMYPNH THi . 210-9354940 a8h:094384144 AoY:KEVOaE ATTIKHZ
Zhzhvuv Zhxinviv HIJ7ouy
Teveio 002
XEIPIETHE 7445
Lovita 1256 MTIKOTA Me TEMIIH ,49 131 Oxvntuz dose #YIIIV YZOccIvju 3,99 13 flrver Z-aata MoAiTIKH 3005 {Cl 59' [ T2akta Bioliaztqhenh Mikfh 0,10 241 ovokaz OYidJk 7,23 ZYnOnO HiHdlza 23 Pezta 10,00 2,77 TevaxiA
{IPA; 000?-2-95-7032 01341238 27-04 2026 13: 17.42 00030c02 6a1c1c9/ooqqueoonly Quoea '15854920 Lurl4 809; J00 M 76 {Ecaed277caaece?ea
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

out = reconcileExtractedReceipt(x("BAZAAR A.E", 99.13, "MYR"), greekNoisyFooterOcr);
assert.ok(Math.abs(out.total - 7.23) < 0.01, `expected noisy-footer OCR total 7.23, got ${out.total}`);
assert.equal(out.currency, "EUR");
assert.ok(!/UID|AUTH|EPSILON/i.test(out.merchant), `merchant should avoid footer noise: ${out.merchant}`);

out = reconcileExtractedReceipt(x("BAZAAR A.E", 10, "EUR"), greekMergedTotalCashLineOcr);
assert.ok(Math.abs(out.total - 7.23) < 0.01, `expected merged-line OCR total 7.23, got ${out.total}`);

out = reconcileExtractedReceipt(x("BAZAAR A.E", 1.49, "EUR"), greekSingleLineBeforeTotalOcr);
assert.ok(Math.abs(out.total - 7.23) < 0.01, `expected single-line OCR total 7.23, got ${out.total}`);

out = reconcileExtractedReceipt(x("BazAar A.E.", 3.99, "MYR"), greekNoisyRealSampleOcr);
assert.ok(Math.abs(out.total - 7.23) < 0.01, `expected real-sample OCR total 7.23, got ${out.total}`);
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

const usInvoiceMergedTotalOcr = `
ONLINE RECEIPT
East Repair Inc.
1912 Harvest Lane New York. NY 12210
RECEIPT #
US-001
Receipt Total
8154.06
Subtotal
145.00
Sales Tax 6.25%
TERMS & CONDITIONS
`.trim();
out = reconcileExtractedReceipt(x("East Repair Inc.", 6.25, "MYR"), usInvoiceMergedTotalOcr);
assert.equal(out.currency, "USD");
assert.ok(Math.abs(out.total - 154.06) < 0.01, `expected merged total 154.06, got ${out.total}`);

const taxLineShouldNotWinOcr = `
Receipt Total
8154.06
Subtotal 145.00
Sales Tax 6.25%
`.trim();
out = reconcileExtractedReceipt(x("Shop", 6.25, "USD"), taxLineShouldNotWinOcr);
assert.ok(Math.abs(out.total - 154.06) < 0.01, `expected total over tax-line 154.06, got ${out.total}`);

console.log("receipt reconcile tests: OK");
