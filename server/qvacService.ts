/**
 * QVAC: OCR (registry) + small LLM JSON extraction on the uploaded receipt image.
 */
import {
  close,
  completion,
  loadModel,
  modelRegistrySearch,
  ocr,
  unloadModel,
} from "@qvac/sdk";
import type {
  ModelProgressUpdate,
  ModelRegistryEntry,
  OCRTextBlock,
} from "@qvac/sdk";
import { jsonrepair } from "jsonrepair";
import sharp from "sharp";
import { reconcileExtractedReceipt } from "./receiptReconcile.js";
import { ReceiptExtractionSchema, type ReceiptExtraction } from "./schema.js";

/** Downscale very large photos before OCR to keep memory predictable (rec_dyn handles line widths). */
const OCR_MAX_PIXEL_EDGE = 2000;

async function prepareImageForOcr(image: Buffer): Promise<Buffer> {
  try {
    const meta = await sharp(image).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w > 0 && h > 0 && w <= OCR_MAX_PIXEL_EDGE && h <= OCR_MAX_PIXEL_EDGE) return image;
    const out = await sharp(image)
      .resize(OCR_MAX_PIXEL_EDGE, OCR_MAX_PIXEL_EDGE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
    console.log("[extract] downscaled for OCR", w, "x", h, "→ max edge", OCR_MAX_PIXEL_EDGE);
    return out;
  } catch (e) {
    console.warn("[extract] sharp resize skipped:", e instanceof Error ? e.message : e);
    return image;
  }
}

async function enhanceImageForOcr(image: Buffer): Promise<Buffer> {
  try {
    return await sharp(image)
      .grayscale()
      .normalize()
      .sharpen()
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch (e) {
    console.warn("[extract] sharp enhance skipped:", e instanceof Error ? e.message : e);
    return image;
  }
}

const SYSTEM_PROMPT = `You extract structured data from retail receipt OCR text. Receipts may be in any language or script (English, Greek, German, French, Spanish, Portuguese, Italian, Polish, Turkish, Russian, Arabic, Hindi, Japanese, Korean, Chinese, etc.). Read the slip in the language printed on it—you do not need English on the receipt.

Reply with ONE JSON object only (no markdown fences, no prose before or after). Use exactly these keys and no others:
merchant (string), total (JSON number only — not a quoted string; major currency units e.g. 12.34), currency (ISO 4217 three-letter code matching the receipt, e.g. EUR, GBP, JPY, USD, CAD, AUD, CHF, MXN, INR, CNY, PLN, SEK, AED, SAR, THB, VND), date (YYYY-MM-DD string when visible; omit if unknown), lineItems (optional array of objects with keys: description required string, quantity optional number, unitPrice optional number, total optional number), category (one of: food, transport, retail, services, utilities, healthcare, other), confidence (number 0-1 required), notes (string or omit).

Put the receipt total in "total" (the final amount the customer pays: grand total / balance due, not line-item subtotals unless no grand total exists). Recognize total words in local languages, e.g. Total, Balance, Amount due, TTC, Gesamt, Montant, ΣΥΝΟΛΟ, ΜΕΡΙΚΟ ΣΥΝΟΛΟ, ИТОГО, 合計, 总计, 应付, 합계, お支払い, Impuesto incl. Never use long UID / auth-code / cryptographic hex / machine-id digit runs as the total.

Numeric formats vary: European comma decimals (7,23), dot decimals (7.23), or thousands grouping (1.234,56 or 1,234.56). Always output "total" as a JSON number with a dot as decimal separator (e.g. 7.23). The symbols $ € £ ¥ ₹ are currency markers only—never read them as digits. If currency is ambiguous but a symbol is printed, infer the ISO code (€→EUR, £→GBP, ¥ ambiguous JP/CN—use receipt context).

For "merchant", prefer the printed store or legal-entity name (often the first substantial line with letters: Α.Ε., S.A., LLC, Ltd, GmbH, OY, AB, 店, etc.). Do not use footer strings, auth codes, or random OCR noise as the merchant. Keep "notes" short. Only include lineItems when there is clear evidence in OCR text. Set confidence lower when OCR is noisy or uncertain. Do not add extra keys.`;

let ocrModelId: string | null = null;
let llmModelId: string | null = null;

function registrySrc(entry: ModelRegistryEntry): string {
  return `registry://${entry.registrySource}/${entry.registryPath}`;
}

function onDownloadProgress(label: string) {
  let last = -1;
  return (p: ModelProgressUpdate) => {
    const pct = p.percentage;
    if (pct == null) return;
    if (pct >= last + 5 || pct === 100) {
      last = Math.floor(pct / 5) * 5;
      console.log(`[QVAC ${label}] download`, pct, "%");
    }
  };
}

function ocrUseGpu(): boolean {
  return process.env.QVAC_USE_GPU !== "false";
}

/**
 * EasyOCR language list (QVAC). Wider list = better non‑English receipts; more langs = larger models / slower first load.
 * Override with QVAC_OCR_LANG_LIST=comma-separated (e.g. "en" only if GPU memory is tight).
 */
function ocrLangList(): string[] {
  const raw =
    process.env.QVAC_OCR_LANG_LIST?.trim() ||
    "en,el,de,fr,es,it,pt,pl,tr,ru,ar,ch_sim,ja,ko,hi,th";
  const parts = raw
    .split(/[,;]+/g)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return parts.length ? [...new Set(parts)] : ["en"];
}

function isRegistryLockError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /file descriptor could not be locked/i.test(msg);
}

async function withRegistryLockRetry<T>(task: () => Promise<T>): Promise<T> {
  const attempts = Number(process.env.QVAC_REGISTRY_RETRY_ATTEMPTS || 4);
  const pauseMs = Number(process.env.QVAC_REGISTRY_RETRY_MS || 400);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await task();
    } catch (e) {
      lastErr = e;
      if (!isRegistryLockError(e) || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, pauseMs * (i + 1)));
    }
  }
  throw lastErr;
}

async function pickOcrEntry(): Promise<ModelRegistryEntry> {
  const list = await withRegistryLockRetry<ModelRegistryEntry[]>(
    () => modelRegistrySearch({ modelType: "ocr" }) as Promise<ModelRegistryEntry[]>
  );
  // Must use engine "onnx-ocr": other OCR engines use different runtimes/graphs; picking them first
  // (e.g. by name) causes ONNX errors like "Invalid input name: image".
  const onnxOcr = list.filter((m: ModelRegistryEntry) => m.engine === "onnx-ocr");
  // `rec_512` Latin = fixed input width (long receipt lines → ORT errors). `rec_dyn` Latin = variable width.
  const latinDyn = onnxOcr.find(
    (m: ModelRegistryEntry) =>
      m.registryPath.includes("rec_dyn") && m.registryPath.includes("recognizer_latin")
  );
  const latin512 = onnxOcr.find(
    (m: ModelRegistryEntry) =>
      m.registryPath.includes("rec_512") && m.registryPath.includes("recognizer_latin")
  );
  const hit =
    latinDyn ||
    latin512 ||
    onnxOcr.find((m: ModelRegistryEntry) => m.name.toLowerCase().includes("latin")) ||
    onnxOcr[0];
  if (!hit) {
    const engines = [...new Set(list.map((m: ModelRegistryEntry) => m.engine))].join(", ");
    throw new Error(
      `No onnx-ocr OCR model in QVAC registry (this app uses the ONNX receipt pipeline). ` +
        `Registry returned ${list.length} OCR model(s) with engines: ${engines || "(none)"}.`
    );
  }
  console.log("[extract] OCR model:", hit.name, `(${hit.engine})`, hit.registryPath);
  return hit;
}

async function pickLlmEntry(): Promise<ModelRegistryEntry> {
  const list = await withRegistryLockRetry<ModelRegistryEntry[]>(() =>
    modelRegistrySearch({
      modelType: "llm",
      filter: "Llama-3.2-1B",
    }) as Promise<ModelRegistryEntry[]>
  );
  const hit =
    list.find(
      (m: ModelRegistryEntry) =>
        m.modelId.includes("Q4_0") && m.modelId.toLowerCase().includes("instruct")
    ) || list[0];
  if (!hit) throw new Error("No suitable small LLM in QVAC registry.");
  return hit;
}

async function ensureOcr(): Promise<string> {
  if (ocrModelId) return ocrModelId;
  const entry = await pickOcrEntry();
  const id = await loadModel({
    modelSrc: registrySrc(entry),
    modelType: "ocr",
    modelConfig: {
      langList: ocrLangList(),
      useGPU: ocrUseGpu(),
      timeout: 120_000,
      pipelineMode: "easyocr",
      magRatio: 1.5,
      defaultRotationAngles: [90, 180, 270],
      contrastRetry: true,
      lowConfidenceThreshold: 0.45,
      recognizerBatchSize: 4,
    },
    onProgress: onDownloadProgress("OCR"),
  });
  ocrModelId = id;
  return id;
}

async function ensureLlm(): Promise<string> {
  if (llmModelId) return llmModelId;
  const entry = await pickLlmEntry();
  const id = await loadModel({
    modelSrc: registrySrc(entry),
    modelType: "llm",
    modelConfig: { ctx_size: 4096, temp: 0.2, predict: 2048 },
    onProgress: onDownloadProgress("LLM"),
  });
  llmModelId = id;
  return id;
}

/** First complete `{ ... }` using brace depth, respecting `"` strings and `\\` escapes. */
function extractFirstBalancedJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = false;
        continue;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseJsonFromLlm(raw: string): unknown {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let body = (fence ? fence[1] : trimmed).trim();
  const balanced = extractFirstBalancedJsonObject(body);
  if (balanced) body = balanced;
  else {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start !== -1 && end > start) body = body.slice(start, end + 1);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (first) {
    try {
      return JSON.parse(jsonrepair(body)) as unknown;
    } catch {
      throw first;
    }
  }
}

export type ExtractPhaseTimings = {
  prepareMs: number;
  ocrMs: number;
  extractMs: number;
};

export type OcrOnlyTimings = {
  prepareMs: number;
  ocrMs: number;
};

function ocrSignalScore(s: string): number {
  const printable = s.replace(/\s+/g, "");
  if (!printable) return 0;
  const alphaNum = (printable.match(/[0-9\p{L}]/gu) ?? []).length;
  return alphaNum;
}

async function runOcrPass(
  modelId: string,
  image: Buffer,
  paragraph: boolean
): Promise<{ text: string; score: number }> {
  const { blocks } = ocr({
    modelId,
    image,
    options: { paragraph },
  });
  const ocrBlocks: OCRTextBlock[] = await blocks;
  const text = ocrBlocks.map((b: OCRTextBlock) => b.text).join("\n");
  return { text, score: ocrSignalScore(text) };
}

export async function extractOcrTextWithQvac(
  image: Buffer
): Promise<{
  ocrText: string;
  timings: OcrOnlyTimings;
  ocrLangsUsed: string[];
  ocrSignalScore: number;
  ocrRetryCount: number;
}> {
  const t0 = Date.now();
  const langs = ocrLangList();
  const imageForOcr = await prepareImageForOcr(image);
  const enhancedImageForOcr = await enhanceImageForOcr(imageForOcr);
  const t1 = Date.now();
  const ocrId = await ensureOcr();
  const primaryPass = await runOcrPass(ocrId, imageForOcr, true);
  let ocrText = primaryPass.text;
  let bestScore = primaryPass.score;
  let retryCount = 0;
  if (bestScore < 42) {
    const fallbackPass = await runOcrPass(ocrId, enhancedImageForOcr, false);
    retryCount = 1;
    if (fallbackPass.score > bestScore) {
      ocrText = fallbackPass.text;
      bestScore = fallbackPass.score;
    }
  }
  const t2 = Date.now();
  return {
    ocrText,
    timings: {
      prepareMs: t1 - t0,
      ocrMs: t2 - t1,
    },
    ocrLangsUsed: langs,
    ocrSignalScore: bestScore,
    ocrRetryCount: retryCount,
  };
}

export async function extractReceiptWithQvac(
  image: Buffer
): Promise<{
  ocrText: string;
  extraction: ReceiptExtraction;
  timings: ExtractPhaseTimings;
  ocrLangsUsed: string[];
  ocrSignalScore: number;
  ocrRetryCount: number;
}> {
  console.log("[extract] loading OCR model (first run can download; watch % logs)…");
  const ocr = await extractOcrTextWithQvac(image);
  const ocrText = ocr.ocrText;
  const t2 = Date.now();
  console.log("[extract] running OCR…", "langs:", ocr.ocrLangsUsed.join(","));
  console.log(
    "[extract] OCR chars:",
    ocrText.length,
    "signalScore:",
    ocr.ocrSignalScore,
    "retries:",
    ocr.ocrRetryCount,
    "prepareMs:",
    ocr.timings.prepareMs,
    "ocrMs:",
    ocr.timings.ocrMs
  );

  console.log("[extract] loading LLM…");
  const llmId = await ensureLlm();
  console.log("[extract] running LLM completion…");
  const { text } = completion({
    modelId: llmId,
    stream: false,
    history: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `OCR text from receipt (language may be non-English; scripts may be mixed or noisy):\n---\n${ocrText}\n---\n` +
          `Reply with JSON only. For "total", use the final payable amount in major currency units. ` +
          `If amounts use a comma as the decimal separator (e.g. 7,23), output the number with a dot (7.23). ` +
          `Treat currency symbols as markers, never as digits. ` +
          `If a printed total looks like 8154.xx but the same cents appear as xxx.xx after a $ or on the total line, use the smaller xxx.xx amount. ` +
          `For "merchant", pick the clearest business name from the header, not footer noise.`,
      },
    ],
    generationParams: { temp: 0.05, predict: 2048 },
  });
  const raw = await text;
  let parsed: unknown;
  try {
    parsed = parseJsonFromLlm(raw);
  } catch (e) {
    const hint =
      e instanceof SyntaxError
        ? " (often the model hit the output token limit — retry extraction.)"
        : "";
    throw new Error(`LLM did not return valid JSON${hint} Raw (truncated): ${raw.slice(0, 500)}`);
  }
  let extraction: ReceiptExtraction;
  try {
    extraction = ReceiptExtractionSchema.parse(parsed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`LLM JSON did not match receipt schema: ${msg}. Raw (truncated): ${raw.slice(0, 500)}`);
  }
  extraction = reconcileExtractedReceipt(extraction, ocrText);
  const t3 = Date.now();
  const timings: ExtractPhaseTimings = {
    prepareMs: ocr.timings.prepareMs,
    ocrMs: ocr.timings.ocrMs,
    extractMs: t3 - t2,
  };
  console.log(
    "[extract] done",
    extraction.merchant,
    extraction.total,
    extraction.currency,
    "timingsMs:",
    timings
  );
  return {
    ocrText,
    extraction,
    timings,
    ocrLangsUsed: ocr.ocrLangsUsed,
    ocrSignalScore: ocr.ocrSignalScore,
    ocrRetryCount: ocr.ocrRetryCount,
  };
}

export async function shutdownQvac(): Promise<void> {
  try {
    if (ocrModelId) {
      await unloadModel({ modelId: ocrModelId, clearStorage: false });
      ocrModelId = null;
    }
    if (llmModelId) {
      await unloadModel({ modelId: llmModelId, clearStorage: false });
      llmModelId = null;
    }
  } finally {
    try {
      await close();
    } catch {
      /* no-op */
    }
  }
}
