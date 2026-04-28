import dotenv from "dotenv";
import cors from "cors";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { suggestedUsdtBaseUnits } from "./fxSettlement.js";
import { extractReceiptWithQvac, shutdownQvac } from "./qvacService.js";
import { indexReceiptForSearch, searchIndexedReceipts, shutdownReceiptSearch } from "./receiptSearchService.js";
import { PayBodySchema, ReceiptIndexBodySchema, ReceiptSearchBodySchema } from "./schema.js";
import { getWalletSignerAddress, sendUsdt } from "./wdkPay.js";
import { displayClusterName, inferSolanaCluster } from "./solanaMeta.js";
import { extractPosFromImage } from "./posExtract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const isProd = process.env.NODE_ENV === "production";
// In dev, project `.env` overrides inherited shell vars so local file wins over the shell.
dotenv.config({
  path: path.join(rootDir, ".env"),
  override: !isProd,
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "512kb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

app.get("/api/health", async (_req, res) => {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const clusterRaw =
    process.env.SOLANA_CLUSTER?.trim() || inferSolanaCluster(rpcUrl);
  const walletReady = Boolean(
    process.env.WALLET_SEED?.trim() && process.env.USDT_MINT?.trim()
  );
  let payerAddress: string | null = null;
  if (walletReady) {
    try {
      payerAddress = await getWalletSignerAddress();
    } catch {
      payerAddress = null;
    }
  }
  res.json({
    ok: true,
    solanaCluster: clusterRaw,
    solanaClusterLabel: displayClusterName(clusterRaw),
    walletReady,
    payerAddress,
    node: process.version,
  });
});

app.post("/api/extract", upload.single("receipt"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      res.status(400).json({ error: "Missing multipart field `receipt` (JPEG/PNG)." });
      return;
    }
    const bytes = req.file.buffer.length;
    console.log("[extract] POST receipt", bytes, "bytes", req.file.mimetype || "");
    const extractDebug =
      process.env.RTC_EXTRACT_DEBUG === "true" || process.env.RTC_EXTRACT_DEBUG === "1";
    const { ocrText, extraction, timings, ocrLangsUsed, ocrSignalScore, ocrRetryCount } =
      await extractReceiptWithQvac(req.file.buffer);
    const { baseUnits: amountBaseUnits, settlementFx } = await suggestedUsdtBaseUnits(
      extraction.total,
      extraction.currency
    );
    const suggestedUsdtUsd = Math.round(amountBaseUnits) / 1e6;
    res.json({
      ocrText,
      extraction,
      suggestedAmountBaseUnits: amountBaseUnits,
      suggestedUsdtUsd,
      settlementFx,
      disclaimer:
        "Totals are inferred locally. Non-USD receipts use indicative FX→USD rates for USDT hints (not live trading quotes). Verify before sending funds. Not financial or tax advice.",
      ...(extractDebug
        ? {
            extractDebug: {
              timings,
              ocrCharCount: ocrText.length,
              ocrLangsUsed,
              ocrSignalScore,
              ocrRetryCount,
            },
          }
        : {}),
    });
  } catch (e) {
    console.error(e);
    const message = e instanceof Error ? e.message : "extract failed";
    res.status(500).json({ error: message });
  }
});

app.post("/api/extract-pos", upload.single("pos"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      res.status(400).json({ error: "Missing multipart field `pos` (JPEG/PNG/WebP)." });
      return;
    }
    const debug =
      process.env.RTC_EXTRACT_DEBUG === "true" || process.env.RTC_EXTRACT_DEBUG === "1";
    const out = await extractPosFromImage(req.file.buffer, { includeDebug: debug });
    res.json({
      ocrText: out.ocrText,
      amount: out.amount,
      currency: out.currency,
      confidence: out.confidence,
      ...(debug && out.debug ? { extractDebug: out.debug } : {}),
    });
  } catch (e) {
    console.error(e);
    const message = e instanceof Error ? e.message : "POS extraction failed";
    const badInput =
      /could not|detect|missing|invalid|retake|visible|text/i.test(message) || message.length < 140;
    res.status(badInput ? 422 : 500).json({ error: message });
  }
});

app.post("/api/pay", async (req, res) => {
  try {
    const body = PayBodySchema.parse(req.body);
    const out = await sendUsdt(body);
    res.json(out);
  } catch (e) {
    console.error(e);
    const message = e instanceof Error ? e.message : "pay failed";
    res.status(400).json({ error: message });
  }
});

app.post("/api/receipts/index", async (req, res) => {
  try {
    const body = ReceiptIndexBodySchema.parse(req.body);
    const out = await indexReceiptForSearch(body);
    res.json(out);
  } catch (e) {
    console.error(e);
    const message = e instanceof Error ? e.message : "index failed";
    res.status(500).json({ error: message });
  }
});

app.post("/api/receipts/search", async (req, res) => {
  try {
    const body = ReceiptSearchBodySchema.parse(req.body);
    const out = await searchIndexedReceipts(body.query, body.limit ?? 8);
    res.json(out);
  } catch (e) {
    console.error(e);
    const message = e instanceof Error ? e.message : "search failed";
    res.status(500).json({ error: message });
  }
});

if (isProd) {
  const clientDist = path.join(rootDir, "client", "dist");
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

const PORT = Number(process.env.PORT || 3847);
const server = app.listen(PORT, () => {
  console.log(`Receipt-to-Crypto API http://127.0.0.1:${PORT}`);
});

async function gracefulShutdown() {
  server.close();
  try {
    await shutdownReceiptSearch();
  } catch {
    /* ignore */
  }
  try {
    await shutdownQvac();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
