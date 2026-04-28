/**
 * Post-LLM reconciliation: OCR + heuristics only override the model when disagreement is clear.
 * Keeps locale-specific logic in one module so US/UK/JP receipts are not accidentally rewritten.
 */
import type { ReceiptExtraction } from "./schema.js";

/** Lines that usually carry the final payable amount (avoid bare "total" — matches too many lines). */
const TOTAL_LINE_HINT =
  /receipt\s+total|invoice\s+total|total\s*due|balance\s*due|amount\s*due|grand\s+total|balance\s*owing|pay\s*this\s*amount|amount\s*owing|^\s*total\s*[:#]|me\s*piko\s*zynoao|\bzynoao\b|synolo|συνολο|μερικο\s+συνολο|μερικο|ΜΕΡΙΚΟ\s+ΣΥΝΟΛΟ|ΜΕΡΙΚΟ|合計|总计|应付|ИТОГО|СУММА|합계|montant\s+ttc|amount\s+payable/im;

/** Greek/EU retail: subtotal / grand total lines (Latin + Greek OCR). */
const EU_TOTAL_LABEL =
  /MEPIKO\s+ZYNOAO|ΜΕΡΙΚΟ\s+ΣΥΝΟΛΟ|\bZYNOAO\b|\bSYNOLO\b|ΣΥΝΟΛΟ|RECEIPT\s+TOTAL|INVOICE\s+TOTAL|TOTAL\s*DUE|BALANCE\s*DUE|GRAND\s+TOTAL|AMOUNT\s*DUE|^\s*TOTAL\s*[:#]/i;

/** Line clearly about basket total (amount often on same or next line). */
const SYNOLO_CLASS_LINE =
  /ΣΥΝΟΛΟ|ΜΕΡΙΚΟ\s+ΣΥΝΟΛΟ|SYNOLO|ZYNOAO|MEPIKO\s+ZYNOAO|SUBTOTAL|GRAND\s+TOTAL|^\s*TOTAL\b|合計|总计|应付|ИТОГО|СУММА|합계|Gesamt|TTC\b/i;

/**
 * Conservative: replace LLM total with OCR candidate only when they clearly disagree.
 * Tuned for small retail slips vs occasional model hallucinations from UID / tax digits.
 */
export function shouldOcrOverrideLlmTotal(llm: number, candidate: number): boolean {
  if (!Number.isFinite(llm) || !Number.isFinite(candidate) || candidate <= 0 || llm <= 0) return false;
  if (candidate >= 999_999) return false;
  const maxv = Math.max(llm, candidate);
  const relDiff = Math.abs(llm - candidate) / maxv;
  if (relDiff <= 0.075) return false;
  if (llm >= 12 && candidate >= 12 && relDiff <= 0.14) return false;
  const ratio = llm / candidate;
  if (ratio >= 1.32) return true;
  if (llm > 400 && candidate < 400 && ratio >= 1.18) return true;
  return false;
}

function parseStandaloneAmountLine(line: string): number | null {
  const normalized = line.trim().replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  const sp = normalized.match(/^(-?)(\d{1,7})\s+(\d{2})$/);
  if (sp) return parseFloat(`${sp[1]}${sp[2]}.${sp[3]}`);
  const c = normalized.match(/^(-?)(\d{1,7}),(\d{2})$/);
  if (c) return parseFloat(`${c[1]}${c[2]}.${c[3]}`);
  const d = normalized.match(/^(-?)(\d{1,7})\.(\d{2})$/);
  if (d) return parseFloat(`${d[1]}${d[2]}.${d[3]}`);
  return null;
}

function parseInlineTotalOnLabelLine(line: string): number | null {
  if (!EU_TOTAL_LABEL.test(line)) return null;
  const normalized = line.trim().replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  const m = normalized.match(/(\d{1,4})(?:\s+|[.,])(\d{2})\s*$/);
  if (!m) return null;
  const v = parseFloat(`${m[1]}.${m[2]}`);
  return Number.isFinite(v) && v > 0 && v < 250_000 ? v : null;
}

function ocrLooksEuro(ocrText: string, labelLine: string): boolean {
  return (
    /€|\bEUR\b|EUR\s*:/i.test(ocrText) ||
    /MEPIKO\s+ZYNOAO|ΜΕΡΙΚΟ\s+ΣΥΝΟΛΟ|ΣΥΝΟΛΟ|\bZYNOAO\b|\bSYNOLO\b/i.test(labelLine)
  );
}

function bestTotalFromSynoloLines(ocrText: string): number | null {
  const lines = ocrText.split(/\r?\n/).map((l) => l.trim());
  const hist = new Map<number, number>();
  for (const line of lines) {
    if (!SYNOLO_CLASS_LINE.test(line)) continue;
    const re = /\b(\d{1,6})[.,](\d{2})\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const v = Math.round(parseFloat(`${m[1]}.${m[2]}`) * 100) / 100;
      if (!Number.isFinite(v) || v <= 0 || v >= 250_000) continue;
      hist.set(v, (hist.get(v) ?? 0) + 1);
    }
  }
  let best: number | null = null;
  let bestc = 0;
  for (const [v, c] of hist) {
    if (c > bestc) {
      best = v;
      bestc = c;
    } else if (c === bestc && best != null && v < best && v >= 2) {
      best = v;
    }
  }
  if (bestc >= 2) return best;
  if (bestc === 1 && best != null && best >= 2 && best <= 250_000) return best;
  return null;
}

function looksLikeGarbageMerchant(s: string): boolean {
  const t = s.trim();
  if (t.length > 140) return true;
  if (/\bUID\b|Auth\s*code|EPSILON|epsilondigital|0x[0-9a-f]{10,}/i.test(t)) return true;
  if (/\d{3}[-\s]?\d{7,}/.test(t) && t.length > 55) return true;
  if (t.length < 5) return false;
  const letters = t.replace(/[^a-z]/gi, "");
  if (letters.length < 6) return false;
  const vowels = (letters.match(/[aeiou]/gi) ?? []).length;
  const r = vowels / letters.length;
  if (r < 0.11) return true;
  if (/^[A-Za-z]{1,3}(\s+[A-Za-z]{1,3}){2,}$/.test(t) && r < 0.22) return true;
  return false;
}

function ocrBeforeElectronicFooter(ocrText: string): string {
  const idx = ocrText.search(
    /\bUID[\s:.]*|Auth\s*code|EPSILON|epsilondigital|ecf47dc|\bECF47|\b0x[0-9a-f]{12,}/i
  );
  if (idx === -1) return ocrText;
  return ocrText.slice(0, idx);
}

function pickMerchantFromOcr(ocrText: string): string | null {
  const head = ocrBeforeElectronicFooter(ocrText);
  const lines = head.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let best: { line: string; score: number } | null = null;
  for (const line of lines.slice(0, 14)) {
    if (line.length < 4 || line.length > 96) continue;
    if (/^\s*\d+[.,]/.test(line)) continue;
    if (
      /receipt|invoice|balance|total|subtotal|tel\.|phone|fax|www\.|@|https?:|uid|auth\s*code|afm|a[oο]m|tax\s*id|iban\b|fiscal|registry|customer|cashier|tameio|temaxia|zeipa|apodeix|αποδειξ|λιανικ|πωλη|συνολο|μεικο/i.test(
        line
      )
    ) {
      continue;
    }
    const alpha = line.replace(/[^a-z]/gi, "");
    if (alpha.length < 4) continue;
    const vow = (alpha.match(/[aeiou]/gi) ?? []).length;
    const vr = vow / alpha.length;
    if (vr < 0.13) continue;
    let score = vr * 8 + Math.min(line.length / 56, 1);
    if (/\b(AE|SA|OY|OU|AB|APS|LLC|INC|LTD|GMBH|SARL|SPA|AG|BV|CV|LP|PLZC|EES|A\.E\.|S\.A\.)\b/i.test(line))
      score += 3;
    if (/\b(MARKET|SHOP|STORE|MART|BAZAAR|SUPER|MINI|CAFE|REST|HOTEL|BANK)\b/i.test(line)) score += 2;
    if (/\d{8,}/.test(line)) score -= 1.5;
    if (!best || score > best.score) best = { line: line.replace(/\s+/g, " ").slice(0, 120), score };
  }
  return best && best.score >= 2.15 ? best.line : null;
}

function needsMerchantRefinement(s: string): boolean {
  return looksLikeGarbageMerchant(s) || /\bUID\b|Auth\s*code|EPSILON|epsilondigital|\d{3}[-\s]?\d{7,}/i.test(s);
}

function refineMerchantField(extraction: ReceiptExtraction, ocrText: string): ReceiptExtraction {
  const m = extraction.merchant.trim();
  if (!needsMerchantRefinement(m)) return extraction;
  const alt = pickMerchantFromOcr(ocrText);
  if (!alt || alt.toLowerCase() === m.toLowerCase()) return extraction;
  console.log("[extract] merchant correction:", JSON.stringify(m), "→", JSON.stringify(alt));
  return { ...extraction, merchant: alt };
}

function fixTotalFromEuAndSynoloOcr(
  extraction: ReceiptExtraction,
  ocrText: string
): ReceiptExtraction {
  const scopedOcrText = ocrBeforeElectronicFooter(ocrText);
  const lines = scopedOcrText.split(/\r?\n/).map((l) => l.trim());
  let candidate: number | null = null;
  let labelLine = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inline = parseInlineTotalOnLabelLine(line);
    if (inline != null) {
      candidate = inline;
      labelLine = line;
      break;
    }
    if (!EU_TOTAL_LABEL.test(line)) continue;
    labelLine = labelLine || line;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const nextLine = lines[j];
      if (/\bUID\b|Auth\s*code|EPSILON|epsilondigital|ECF47|0x[0-9a-f]{8,}/i.test(nextLine)) continue;
      const v = parseStandaloneAmountLine(nextLine);
      if (v != null && v > 0 && v < 250_000) {
        candidate = v;
        labelLine = line;
        break;
      }
    }
    if (candidate != null) break;
  }

  if (candidate == null) {
    candidate = bestTotalFromSynoloLines(scopedOcrText);
    if (candidate != null) labelLine = labelLine || "ΣΥΝΟΛΟ/SYNOLO block";
  }

  if (candidate == null) return extraction;

  const t = extraction.total;
  if (!Number.isFinite(t) || t <= 0) return extraction;

  if (!shouldOcrOverrideLlmTotal(t, candidate)) return extraction;

  let currency = extraction.currency;
  if (ocrLooksEuro(scopedOcrText, labelLine) && extraction.currency === "USD") currency = "EUR";
  if (/(ΣΥΝΟΛΟ|ΜΕΡΙΚΟ|ΕΥΡΩ|EUR|€)/i.test(scopedOcrText) && extraction.currency === "USD") currency = "EUR";

  console.log("[extract] total correction:", t, "→", candidate, "(OCR total vs LLM; conservative gate)");
  return { ...extraction, total: candidate, currency };
}

export function amountsFromLine(line: string): number[] {
  const out: number[] = [];
  const normalized = line.replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  const re = /-?[\d,]+\.\d{2}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    const v = parseFloat(m[0].replace(/,/g, ""));
    if (Number.isFinite(v)) out.push(v);
  }
  const reEu = /-?\d{1,7},\d{2}\b/g;
  while ((m = reEu.exec(normalized)) !== null) {
    const v = parseFloat(m[0].replace(",", "."));
    if (Number.isFinite(v)) out.push(v);
  }
  const reSpaced = /-?\d{1,7}\s+\d{2}\b/g;
  while ((m = reSpaced.exec(normalized)) !== null) {
    const v = parseFloat(m[0].replace(/\s+/, "."));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

function* eachTotalHintWindow(ocrText: string): Generator<string, void, unknown> {
  const lines = ocrText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const window = [lines[i], lines[i + 1]].filter(Boolean).join("\n");
    if (TOTAL_LINE_HINT.test(window)) yield window;
  }
}

function amountsOnTotalHintLines(ocrText: string): Set<number> {
  const found = new Set<number>();
  for (const w of eachTotalHintWindow(ocrText)) {
    for (const v of amountsFromLine(w)) found.add(v);
  }
  return found;
}

function dollarPrefixedAmounts(ocrText: string): Set<number> {
  const dollars = new Set<number>();
  const dollarRe = /\$\s*([\d,]+\.\d{1,2})\b/g;
  let dm: RegExpExecArray | null;
  while ((dm = dollarRe.exec(ocrText)) !== null) {
    const v = parseFloat(dm[1].replace(/,/g, ""));
    if (Number.isFinite(v)) dollars.add(v);
  }
  return dollars;
}

function fixTotalIfDollarSignMisreadAsEight(
  extraction: ReceiptExtraction,
  ocrText: string
): ReceiptExtraction {
  const tStr = extraction.total.toFixed(2);
  if (!tStr.startsWith("8")) return extraction;

  const cents = tStr.slice(tStr.indexOf(".") + 1);
  const ocrHasDollar = /\$\s*[\d,.]+\.?\d*/.test(ocrText) || ocrText.includes("$");
  if (cents === "00" && !ocrHasDollar && extraction.total >= 100 && extraction.total < 1_000_000) {
    return extraction;
  }

  const alt = parseFloat(tStr.slice(1));
  if (!Number.isFinite(alt) || alt <= 0) return extraction;

  const dollars = dollarPrefixedAmounts(ocrText);
  for (const d of dollars) {
    if (Math.abs(d - alt) < 0.005) {
      console.log("[extract] total correction:", extraction.total, "→", alt, "(leading 8; `$` amount in OCR)");
      return { ...extraction, total: alt };
    }
  }

  const onTotalLines = amountsOnTotalHintLines(ocrText);
  for (const v of onTotalLines) {
    if (Math.abs(v - alt) < 0.005) {
      console.log("[extract] total correction:", extraction.total, "→", alt, "(leading 8; total/balance line in OCR)");
      return { ...extraction, total: alt };
    }
  }

  const weakOk = extraction.total >= 1_000;
  if (weakOk) {
    for (const window of eachTotalHintWindow(ocrText)) {
      for (const v of amountsFromLine(window)) {
        if (Math.abs(v - extraction.total) < 0.005) {
          console.log(
            "[extract] total correction:",
            extraction.total,
            "→",
            alt,
            "(leading 8; merged `$` on total/balance line)"
          );
          return { ...extraction, total: alt };
        }
      }
    }
    const altEsc = alt.toFixed(2).replace(/\./g, "\\.");
    if (new RegExp(`\\b${altEsc}\\b`).test(ocrText)) {
      console.log("[extract] total correction:", extraction.total, "→", alt, "(leading 8; same amount elsewhere in OCR)");
      return { ...extraction, total: alt };
    }
  }

  return extraction;
}

/**
 * Single post-LLM pass: merchant cleanup, OCR-backed total (when safe), then `$`→leading-8 fix.
 */
export function reconcileExtractedReceipt(
  extraction: ReceiptExtraction,
  ocrText: string
): ReceiptExtraction {
  let out = refineMerchantField(extraction, ocrText);
  out = fixTotalFromEuAndSynoloOcr(out, ocrText);
  out = fixTotalIfDollarSignMisreadAsEight(out, ocrText);
  return out;
}
