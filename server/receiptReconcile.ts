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
  /MEPIKO\s+ZYNOAO|ΜΕΡΙΚΟ\s+ΣΥΝΟΛΟ|\bZYNOAO\b|\bSYNOLO\b|ΣΥΝΟΛΟ|RECEIPT\s+TOTAL|INVOICE\s+TOTAL|TOTAL\s*DUE|BALANCE\s*DUE|GRAND\s+TOTAL|AMOUNT\s*DUE|TOTAL\s*PAID|^\s*TOTAL\s*[:#]/i;

/** Very strong final-payment hints: prefer these over generic totals/subtotals. */
const TOTAL_PAID_OR_TENDER_LABEL =
  /TOTAL\s*PAID|AMOUNT\s*PAID|PAID\s+AMOUNT|ΠΛΗΡΩΜΗ|PAYMENT|CARD\s+PAYMENT/i;

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
  const minv = Math.min(llm, candidate);
  const relDiff = Math.abs(llm - candidate) / maxv;
  if (relDiff <= 0.075) return false;
  if (llm >= 12 && candidate >= 12 && relDiff <= 0.14) return false;
  const ratio = maxv / Math.max(minv, 0.0001);
  if (ratio >= 1.32) return true;
  if (maxv > 400 && minv < 400 && ratio >= 1.18) return true;
  return false;
}

function parseStandaloneAmountLine(line: string): number | null {
  const normalized = line.trim().replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  const compact = normalized.replace(/\s+/g, "");
  const sp = normalized.match(/^(-?)(\d{1,7})\s+(\d{2})$/);
  if (sp) return parseFloat(`${sp[1]}${sp[2]}.${sp[3]}`);
  const c = compact.match(/^(-?)(\d{1,7}),(\d{2})$/);
  if (c) return parseFloat(`${c[1]}${c[2]}.${c[3]}`);
  const d = compact.match(/^(-?)(\d{1,7})\.(\d{2})$/);
  if (d) return parseFloat(`${d[1]}${d[2]}.${d[3]}`);
  return null;
}

function parseAmountCandidatesFromLine(line: string, opts?: { allowInteger?: boolean }): number[] {
  const normalized = line.trim().replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  const out = new Set<number>();
  const re = /(-?\d{1,7})\s*([.,])\s*(\d{2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    const v = Math.round(parseFloat(`${m[1]}.${m[3]}`) * 100) / 100;
    if (Number.isFinite(v) && v > 0 && v < 250_000) out.add(v);
  }
  const reSpaced = /(-?\d{1,7})\s+(\d{2})\b/g;
  while ((m = reSpaced.exec(normalized)) !== null) {
    const v = Math.round(parseFloat(`${m[1]}.${m[2]}`) * 100) / 100;
    if (Number.isFinite(v) && v > 0 && v < 250_000) out.add(v);
  }
  if (opts?.allowInteger) {
    const reInt = /\b(\d{1,6})\b/g;
    while ((m = reInt.exec(normalized)) !== null) {
      const n = Number.parseInt(m[1], 10);
      if (!Number.isFinite(n) || n <= 0 || n >= 250_000) continue;
      if (n >= 1900 && n <= 2099) continue;
      out.add(n);
    }
  }
  return [...out];
}

function parseInlineTotalOnLabelLine(line: string): number | null {
  if (!EU_TOTAL_LABEL.test(line) && !TOTAL_PAID_OR_TENDER_LABEL.test(line)) return null;
  const amounts = parseAmountCandidatesFromLine(line);
  if (!amounts.length) return null;
  return amounts[amounts.length - 1] ?? null;
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

function looksLikeFooterNoiseLine(line: string): boolean {
  return (
    /\bUID\b|Auth\s*code|EPSILON|epsilondigital|ECF47|0x[0-9a-f]{8,}|AFM|tax\s*id|fiscal|machine\s*id/i.test(
      line
    ) ||
    /\d{8,}/.test(line)
  );
}

function pickBestTotalCandidate(
  lines: string[]
): { amount: number; labelLine: string } | null {
  const scored: Array<{ amount: number; score: number; labelLine: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || looksLikeFooterNoiseLine(line)) continue;
    const strong = TOTAL_PAID_OR_TENDER_LABEL.test(line);
    const totalish = EU_TOTAL_LABEL.test(line) || SYNOLO_CLASS_LINE.test(line);
    if (!strong && !totalish) continue;

    const baseScore = strong ? 7 : 4;
    for (const amount of parseAmountCandidatesFromLine(line, { allowInteger: strong })) {
      scored.push({ amount, score: baseScore + 2, labelLine: line });
    }

    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const nextLine = lines[j];
      if (!nextLine || looksLikeFooterNoiseLine(nextLine)) continue;
      const standalone = parseStandaloneAmountLine(nextLine);
      if (standalone != null) {
        scored.push({ amount: standalone, score: baseScore + 1, labelLine: line });
      }
      for (const amount of parseAmountCandidatesFromLine(nextLine)) {
        scored.push({ amount, score: baseScore, labelLine: line });
      }
      if (strong && /^\s*[\d\s.,]+\s*$/.test(nextLine)) {
        for (const amount of parseAmountCandidatesFromLine(nextLine, { allowInteger: true })) {
          scored.push({ amount, score: baseScore + 0.5, labelLine: line });
        }
      }
    }
  }
  if (!scored.length) return null;

  const hist = new Map<number, { score: number; count: number; labelLine: string }>();
  for (const c of scored) {
    const prev = hist.get(c.amount);
    if (!prev) {
      hist.set(c.amount, { score: c.score, count: 1, labelLine: c.labelLine });
      continue;
    }
    prev.score += c.score;
    prev.count += 1;
    if (c.score > prev.score) prev.labelLine = c.labelLine;
  }

  let best: { amount: number; score: number; count: number; labelLine: string } | null = null;
  for (const [amount, info] of hist) {
    const candidate = { amount, score: info.score, count: info.count, labelLine: info.labelLine };
    if (!best) {
      best = candidate;
      continue;
    }
    if (candidate.score > best.score) {
      best = candidate;
      continue;
    }
    if (candidate.score === best.score && candidate.count > best.count) {
      best = candidate;
      continue;
    }
    if (candidate.score === best.score && candidate.count === best.count && candidate.amount < best.amount) {
      best = candidate;
    }
  }
  return best ? { amount: best.amount, labelLine: best.labelLine } : null;
}

function pickBestHintedTotal(ocrText: string): { amount: number; labelLine: string } | null {
  const lines = ocrText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const scored: Array<{ amount: number; score: number; labelLine: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (looksLikeFooterNoiseLine(line)) continue;
    const isHint = TOTAL_LINE_HINT.test(line);
    if (!isHint) continue;
    const nearBottom = i >= lines.length - 8 ? 0.5 : 0;
    for (const amount of parseAmountCandidatesFromLine(line, { allowInteger: true })) {
      scored.push({ amount, score: 5 + nearBottom, labelLine: line });
    }
    for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
      const nextLine = lines[j];
      if (!nextLine || looksLikeFooterNoiseLine(nextLine)) continue;
      const standalone = parseStandaloneAmountLine(nextLine);
      if (standalone != null) scored.push({ amount: standalone, score: 4 + nearBottom, labelLine: line });
      for (const amount of parseAmountCandidatesFromLine(nextLine, { allowInteger: /^\s*[\d\s.,]+\s*$/.test(nextLine) })) {
        scored.push({ amount, score: 3 + nearBottom, labelLine: line });
      }
    }
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || b.amount - a.amount);
  return { amount: scored[0].amount, labelLine: scored[0].labelLine };
}

function pickFallbackAmountCandidate(ocrText: string): { amount: number; labelLine: string } | null {
  const lines = ocrText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 200);
  const hist = new Map<number, { score: number; labelLine: string; count: number }>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || looksLikeFooterNoiseLine(line)) continue;
    const hint = TOTAL_LINE_HINT.test(line);
    const nearBottom = i >= lines.length - 10;
    const hasCurrency = /[$€£¥₩₹]|\b(?:RM|MYR|USD|EUR|GBP|JPY|CNY)\b/i.test(line);
    for (const amount of parseAmountCandidatesFromLine(line, { allowInteger: hint })) {
      if (amount <= 0 || amount >= 250_000) continue;
      let score = 1;
      if (hint) score += 1.2;
      if (nearBottom) score += 0.6;
      if (hasCurrency) score += 0.35;
      if (/\d[.,]\d{2}\b/.test(line)) score += 0.25;
      const prev = hist.get(amount);
      if (prev) {
        prev.score += score;
        prev.count += 1;
      } else {
        hist.set(amount, { score, labelLine: line, count: 1 });
      }
    }
  }
  let best: { amount: number; score: number; count: number; labelLine: string } | null = null;
  for (const [amount, info] of hist) {
    const c = { amount, score: info.score, count: info.count, labelLine: info.labelLine };
    if (!best || c.score > best.score || (c.score === best.score && c.count > best.count)) best = c;
  }
  return best && best.score >= 1.6 ? { amount: best.amount, labelLine: best.labelLine } : null;
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

  const best = pickBestTotalCandidate(lines);
  if (best) {
    candidate = best.amount;
    labelLine = best.labelLine;
  }

  if (candidate == null) {
    candidate = bestTotalFromSynoloLines(scopedOcrText);
    if (candidate != null) labelLine = labelLine || "ΣΥΝΟΛΟ/SYNOLO block";
  }
  if (candidate == null) {
    const hinted = pickBestHintedTotal(scopedOcrText);
    if (hinted) {
      candidate = hinted.amount;
      labelLine = hinted.labelLine;
    }
  }
  if (candidate == null) {
    const fallback = pickFallbackAmountCandidate(scopedOcrText);
    if (fallback) {
      candidate = fallback.amount;
      labelLine = fallback.labelLine;
    }
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

const CURRENCY_HINTS: Array<{ currency: string; re: RegExp; weight: number }> = [
  { currency: "MYR", re: /\bMYR\b|\bRINGGIT\b|(?:^|[^A-Z])RM\s*\d/i, weight: 4 },
  { currency: "EUR", re: /€|\bEUR\b|ΜΕΡΙΚΟ|ΣΥΝΟΛΟ|TTC\b/i, weight: 3 },
  { currency: "GBP", re: /£|\bGBP\b/i, weight: 3 },
  { currency: "JPY", re: /¥|\bJPY\b|円/i, weight: 3 },
  { currency: "CNY", re: /\bCNY\b|\bRMB\b|￥|人民币/i, weight: 3 },
  { currency: "KRW", re: /\bKRW\b|₩/i, weight: 3 },
  { currency: "INR", re: /\bINR\b|₹/i, weight: 3 },
  { currency: "THB", re: /\bTHB\b|฿/i, weight: 3 },
  { currency: "USD", re: /\bUSD\b|\$\s*\d/i, weight: 2 },
];

function inferCurrencyFromOcr(ocrText: string): string | null {
  const tally = new Map<string, number>();
  for (const hint of CURRENCY_HINTS) {
    if (!hint.re.test(ocrText)) continue;
    tally.set(hint.currency, (tally.get(hint.currency) ?? 0) + hint.weight);
  }
  let best: { currency: string; score: number } | null = null;
  for (const [currency, score] of tally) {
    if (!best || score > best.score) best = { currency, score };
  }
  return best && best.score >= 3 ? best.currency : null;
}

function refineCurrencyField(extraction: ReceiptExtraction, ocrText: string): ReceiptExtraction {
  const inferred = inferCurrencyFromOcr(ocrText);
  if (!inferred || inferred === extraction.currency) return extraction;
  if (extraction.currency !== "USD") return extraction;
  console.log("[extract] currency correction:", extraction.currency, "→", inferred, "(OCR evidence)");
  return { ...extraction, currency: inferred };
}

function bestMyrTaggedAmount(ocrText: string): number | null {
  const lines = ocrText.split(/\r?\n/);
  let best: { amount: number; score: number } | null = null;
  const re = /(?:^|[^A-Z])RM\s*([0-9]{1,6}(?:[.,][0-9]{2})?)/gi;
  for (const line of lines) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const v =
        parseStandaloneAmountLine(m[1]) ?? parseAmountCandidatesFromLine(m[1], { allowInteger: true })[0] ?? null;
      if (v == null || v <= 0 || v >= 250_000) continue;
      let score = 1;
      if (TOTAL_LINE_HINT.test(line)) score += 3;
      if (/(cash|change|paid|tender)/i.test(line)) score -= 1.5;
      if (!best || score > best.score || (score === best.score && v > best.amount)) {
        best = { amount: v, score };
      }
    }
  }
  return best?.amount ?? null;
}

function fixTotalFromMyrTaggedAmounts(extraction: ReceiptExtraction, ocrText: string): ReceiptExtraction {
  if (extraction.currency !== "MYR") return extraction;
  const suspicious = extraction.total >= 1_000 || extraction.total < 1;
  if (!suspicious) return extraction;
  const candidate = bestMyrTaggedAmount(ocrText);
  if (!candidate) return extraction;
  if (!shouldOcrOverrideLlmTotal(extraction.total, candidate)) return extraction;
  console.log("[extract] total correction:", extraction.total, "→", candidate, "(RM-tagged OCR amount)");
  return { ...extraction, total: candidate };
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
  out = refineCurrencyField(out, ocrText);
  out = fixTotalFromEuAndSynoloOcr(out, ocrText);
  out = fixTotalFromMyrTaggedAmounts(out, ocrText);
  out = fixTotalIfDollarSignMisreadAsEight(out, ocrText);
  return out;
}
