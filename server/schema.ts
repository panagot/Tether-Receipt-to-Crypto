import { z } from "zod";

export const ReceiptExtractionSchema = z.object({
  merchant: z.string().min(1),
  total: z.number().nonnegative(),
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
