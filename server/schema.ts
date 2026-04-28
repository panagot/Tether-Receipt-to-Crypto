import { z } from "zod";

/** Parse totals the LLM may emit as strings (EU comma decimals vs US thousands). */
function parseTotalString(raw: string): number {
  const s = raw.trim().replace(/\u00a0/g, " ").replace(/\s/g, "");
  // EU-style: exactly one comma as decimal separator (e.g. 7,23 or 81,54).
  const eu = s.match(/^(-?)(\d{1,7}),(\d{2})$/);
  if (eu) return parseFloat(`${eu[1]}${eu[2]}.${eu[3]}`);
  // US-style thousands + dot decimal: 1,234.56
  const us = s.match(/^(-?)(\d{1,3}(?:,\d{3})+)(\.\d+)?$/);
  if (us?.[3]) {
    return parseFloat(`${us[1]}${us[2].replace(/,/g, "")}${us[3]}`);
  }
  const t = s.replace(/,/g, "");
  const m = t.match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : parseFloat(t);
}

const totalFromLlm = z.preprocess((v) => {
  if (typeof v === "string") return parseTotalString(v);
  return v;
}, z.number().nonnegative());

function normalizeCurrencyCode(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim().toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
  if (t === "EURO") return "EUR";
  return t.length === 3 ? t : v;
}

const currencyFromLlm = z.preprocess(normalizeCurrencyCode, z.string().min(1).default("USD"));

const ReceiptCategorySchema = z.enum([
  "food",
  "transport",
  "retail",
  "services",
  "utilities",
  "healthcare",
  "other",
]);

const ReceiptLineItemSchema = z
  .object({
    description: z.string().min(1),
    quantity: z.number().positive().optional(),
    unitPrice: z.number().nonnegative().optional(),
    total: z.number().nonnegative().optional(),
  })
  .strict();

export const ReceiptExtractionSchema = z
  .object({
    merchant: z.string().min(1),
    total: totalFromLlm,
    currency: currencyFromLlm,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    lineItems: z.array(ReceiptLineItemSchema).max(40).optional(),
    category: ReceiptCategorySchema,
    confidence: z.number().min(0).max(1),
    notes: z.string().max(400).optional(),
  })
  .strict();

export type ReceiptExtraction = z.infer<typeof ReceiptExtractionSchema>;

export const PayBodySchema = z.object({
  recipient: z.string().min(32).max(48),
  amountBaseUnits: z.number().int().positive(),
  memo: z.string().max(128).optional(),
});

export const ReceiptIndexBodySchema = z.object({
  merchant: z.string().min(1),
  total: z.number().finite(),
  category: z.string(),
  ocrText: z.string(),
});

export const ReceiptSearchBodySchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(20).optional(),
});
