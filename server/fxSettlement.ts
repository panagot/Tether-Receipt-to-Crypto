/**
 * Indicative receipt-currency → USD rates for USDT settlement hints (USDT tracks USD).
 * Frankfurter (ECB-based); optional per-currency `{ISO}_USD_RATE` env overrides; static fallbacks if fetch fails.
 */

export type SettlementFxSource = "env" | "frankfurter" | "fallback" | "unmapped";

export type SettlementFxInfo = {
  from: string;
  to: string;
  rate: number;
  source: SettlementFxSource;
  /** Rate date when source is frankfurter */
  asOf?: string;
};

/**
 * Rough USD per 1 unit of foreign currency when the API is unreachable (not a trading quote).
 * Updated occasionally; prefer Frankfurter in production.
 */
const FALLBACK_USD_PER_UNIT: Record<string, number> = {
  EUR: 1.08,
  GBP: 1.27,
  JPY: 0.0068,
  CHF: 1.12,
  CAD: 0.72,
  AUD: 0.65,
  SEK: 0.095,
  NOK: 0.092,
  DKK: 0.145,
  PLN: 0.25,
  MXN: 0.055,
  SGD: 0.74,
  CNY: 0.138,
  INR: 0.012,
  NZD: 0.6,
  KRW: 0.00072,
  HKD: 0.128,
  TRY: 0.029,
  BRL: 0.17,
  PHP: 0.017,
  THB: 0.029,
  ZAR: 0.055,
  CZK: 0.043,
  HUF: 0.0028,
  ILS: 0.27,
  IDR: 0.000063,
  MYR: 0.22,
  RON: 0.21,
  BGN: 0.55,
  ISK: 0.0072,
  AED: 0.272,
  SAR: 0.267,
  QAR: 0.275,
  KWD: 3.25,
  VND: 0.00004,
  TWD: 0.031,
  PKR: 0.0036,
  EGP: 0.02,
  COP: 0.00024,
  CLP: 0.00105,
  ARS: 0.001,
  PEN: 0.27,
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FRANKFURTER_BASE = "https://api.frankfurter.app/latest";

const cache = new Map<string, { rate: number; asOf: string; at: number }>();

/** Normalize LLM / receipt text to a 3-letter ISO code we might support. */
export function normalizeReceiptCurrency(raw: string): string {
  const c = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (c === "EURO") return "EUR";
  return c;
}

function parseManualRate(fromIso: string): number | null {
  const legacyEur = process.env.EUR_USD_RATE?.trim();
  if (fromIso === "EUR" && legacyEur) {
    const n = parseFloat(legacyEur);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const key = `${fromIso}_USD_RATE`;
  const raw = process.env[key]?.trim();
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchFrankfurterToUsd(fromIso: string): Promise<{ rate: number; asOf: string }> {
  const now = Date.now();
  const hit = cache.get(fromIso);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return { rate: hit.rate, asOf: hit.asOf };
  }
  const url = `${FRANKFURTER_BASE}?from=${encodeURIComponent(fromIso)}&to=USD`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8_000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { date?: string; rates?: { USD?: number } };
    const usd = j.rates?.USD;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
      throw new Error("missing or invalid rates.USD");
    }
    const asOf = typeof j.date === "string" ? j.date : "";
    cache.set(fromIso, { rate: usd, asOf, at: now });
    return { rate: usd, asOf };
  } finally {
    clearTimeout(t);
  }
}

export async function currencyToUsdForSettlement(fromIso: string): Promise<SettlementFxInfo> {
  const manual = parseManualRate(fromIso);
  if (manual != null) {
    return { from: fromIso, to: "USD", rate: manual, source: "env" };
  }
  try {
    const { rate, asOf } = await fetchFrankfurterToUsd(fromIso);
    return { from: fromIso, to: "USD", rate, source: "frankfurter", ...(asOf ? { asOf } : {}) };
  } catch (e) {
    const fb = FALLBACK_USD_PER_UNIT[fromIso];
    if (typeof fb === "number" && fb > 0) {
      console.warn(`[fx] ${fromIso}/USD API failed, static fallback:`, e instanceof Error ? e.message : e);
      return { from: fromIso, to: "USD", rate: fb, source: "fallback" };
    }
    console.warn(
      `[fx] ${fromIso}/USD unavailable (not on Frankfurter list or network error); USDT hint uses 1:1 USD notional:`,
      e instanceof Error ? e.message : e
    );
    return { from: fromIso, to: "USD", rate: 1, source: "unmapped" };
  }
}

/**
 * USDT minor units (6 decimals): micro-USDT that match the receipt total for settlement hints.
 */
function isIso4217Alpha3(c: string): boolean {
  return /^[A-Z]{3}$/.test(c);
}

/**
 * Micro-USDT (6 dp) for the receipt total. Any plausible ISO code is converted via Frankfurter when possible;
 * otherwise 1:1 USD notional with `source: "unmapped"` so the UI can warn.
 */
export async function suggestedUsdtBaseUnits(
  total: number,
  currencyRaw: string
): Promise<{ baseUnits: number; settlementFx: SettlementFxInfo | null }> {
  if (!Number.isFinite(total) || total < 0) {
    return { baseUnits: 0, settlementFx: null };
  }
  const c = normalizeReceiptCurrency(currencyRaw);
  if (c === "USD" || c === "USDT") {
    return { baseUnits: Math.round(total * 1e6), settlementFx: null };
  }
  if (!isIso4217Alpha3(c)) {
    console.warn("[fx] non–ISO-4217 currency; USDT hint uses 1:1 USD notional:", currencyRaw);
    return {
      baseUnits: Math.round(total * 1e6),
      settlementFx: { from: c.slice(0, 3) || "???", to: "USD", rate: 1, source: "unmapped" },
    };
  }
  const fx = await currencyToUsdForSettlement(c);
  const usd = total * fx.rate;
  return { baseUnits: Math.round(usd * 1e6), settlementFx: fx };
}
