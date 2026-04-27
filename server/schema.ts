import { z } from "zod";

function parseTotalString(raw: string): number {
  const t = raw.replace(/,/g, "").trim();
  const m = t.match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : parseFloat(t);
}

const totalFromLlm = z.preprocess((v) => {
  if (typeof v === "string") return parseTotalString(v);
  return v;
}, z.number().nonnegative());

export const ReceiptExtractionSchema = z.object({
  merchant: z.string().min(1),
  total: totalFromLlm,
  currency: z.string().min(1).default("USD"),
  category: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  notes: z.string().optional(),
});

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
