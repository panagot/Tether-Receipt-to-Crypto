import { extractOcrTextWithQvac } from "./qvacService.js";

const CURRENCY_SYMBOL_MAP: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₩": "KRW",
  "₹": "INR",
  "₺": "TRY",
  "₽": "RUB",
  "₴": "UAH",
  "₫": "VND",
  "₦": "NGN",
  "₱": "PHP",
  "₪": "ILS",
  "₡": "CRC",
  "₲": "PYG",
  "₵": "GHS",
};

const CURRENCY_CODE_RE = /\b(USD|EUR|GBP|JPY|CNY|CAD|AUD|CHF|HKD|SGD|NZD|SEK|NOK|DKK|PLN|CZK|HUF|RON|BGN|AED|SAR|QAR|KWD|BHD|OMR|TRY|ILS|INR|PKR|BDT|LKR|THB|VND|KRW|PHP|IDR|MYR|ZAR|NGN|EGP|MXN|BRL|ARS|CLP|COP|PEN|UAH|RUB)\b/i;
const AMOUNT_LINE_HINT_RE = /\b(total|amount|due|pay|sale|charge|grand|sum|balance|final|net|visa|master|card)\b/i;

function parsePossiblyLocalizedAmount(raw: string): number | null {
  const s = raw.trim().replace(/\s+/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  const hasComma = lastComma !== -1;
  const hasDot = lastDot !== -1;
  let normalized = s;
  if (hasComma && hasDot) {
    const decimalIsComma = lastComma > lastDot;
    normalized = decimalIsComma
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(/,/g, "");
  } else if (hasComma && !hasDot) {
    const frac = s.slice(lastComma + 1);
    normalized = frac.length === 2 ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (hasDot) {
    const frac = s.slice(lastDot + 1);
    normalized = frac.length === 2 ? s : s.replace(/\./g, "");
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const amount = Number.parseFloat(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

function detectCurrency(text: string): { currency: string; confidenceBoost: number } {
  const code = text.match(CURRENCY_CODE_RE)?.[1]?.toUpperCase();
  if (code) return { currency: code, confidenceBoost: 0.28 };
  const symbols = Object.keys(CURRENCY_SYMBOL_MAP).filter((sym) => text.includes(sym));
  if (symbols.length > 0) {
    return { currency: CURRENCY_SYMBOL_MAP[symbols[0]], confidenceBoost: 0.18 };
  }
  return { currency: "USD", confidenceBoost: 0 };
}

type AmountCandidate = {
  amount: number;
  score: number;
  line: string;
};

function collectAmountCandidates(text: string): AmountCandidate[] {
  const lines = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 140);
  const candidates: AmountCandidate[] = [];
  const amountLike = /(?:[$€£¥₩₹₺₽₴₫₦₱₪₡₲₵]\s*)?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2})/g;
  lines.forEach((line, idx) => {
    let match: RegExpExecArray | null = null;
    while ((match = amountLike.exec(line)) !== null) {
      const amount = parsePossiblyLocalizedAmount(match[1]);
      if (amount == null) continue;
      if (amount > 1_000_000) continue;
      let score = 0.4;
      if (AMOUNT_LINE_HINT_RE.test(line)) score += 0.35;
      if (/[€$£¥₩₹]/.test(line)) score += 0.1;
      if (idx >= lines.length - 3) score += 0.08;
      const fractional = Math.round((amount - Math.floor(amount)) * 100);
      if (fractional > 0 && fractional < 100) score += 0.08;
      candidates.push({ amount, score, line });
    }
  });
  return candidates.sort((a, b) => b.score - a.score);
}

export type PosExtractionResult = {
  ocrText: string;
  amount: number;
  currency: string;
  confidence: number;
  debug?: {
    ocrLangsUsed: string[];
    ocrSignalScore: number;
    ocrRetryCount: number;
    timings: {
      prepareMs: number;
      ocrMs: number;
      parseMs: number;
    };
    topCandidates: Array<{ amount: number; score: number; line: string }>;
  };
};

export async function extractPosFromImage(
  image: Buffer,
  opts?: { includeDebug?: boolean }
): Promise<PosExtractionResult> {
  const parseStart = Date.now();
  const ocr = await extractOcrTextWithQvac(image);
  const ocrText = ocr.ocrText.trim();
  if (!ocrText || ocrText.length < 4) {
    throw new Error("Could not read enough text from POS image. Retake closer and avoid glare.");
  }
  const candidates = collectAmountCandidates(ocrText);
  if (candidates.length === 0) {
    throw new Error("Could not detect a POS amount. Ensure total is visible in the photo.");
  }
  const best = candidates[0];
  const currencyDetect = detectCurrency(ocrText);
  const confidence = Math.max(
    0.2,
    Math.min(0.98, best.score + currencyDetect.confidenceBoost + Math.min(0.2, ocr.ocrSignalScore / 200))
  );
  const parseMs = Date.now() - parseStart;
  return {
    ocrText,
    amount: Number(best.amount.toFixed(2)),
    currency: currencyDetect.currency || "USD",
    confidence,
    ...(opts?.includeDebug
      ? {
          debug: {
            ocrLangsUsed: ocr.ocrLangsUsed,
            ocrSignalScore: ocr.ocrSignalScore,
            ocrRetryCount: ocr.ocrRetryCount,
            timings: {
              prepareMs: ocr.timings.prepareMs,
              ocrMs: ocr.timings.ocrMs,
              parseMs,
            },
            topCandidates: candidates.slice(0, 5).map((c) => ({
              amount: c.amount,
              score: Number(c.score.toFixed(3)),
              line: c.line.slice(0, 140),
            })),
          },
        }
      : {}),
  };
}
