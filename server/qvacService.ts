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

const SYSTEM_PROMPT = `You extract structured data from retail receipt OCR text.

Reply with ONE JSON object only (no markdown fences, no prose before or after). Use exactly these keys and no others:
merchant (string), total (JSON number only — not a quoted string; major currency units e.g. 12.34), currency (ISO 4217 string), category (one of: food, transport, retail, services, utilities, healthcare, other), confidence (number 0-1), notes (string or omit).

Put the receipt total in "total" (not subtotals). Use the final amount next to labels like "Receipt Total", "TOTAL", or "Balance due". The symbol $ is currency only — never read it as the digit 8. Keep "notes" short. Do not add extra keys (no payment_method, due_date, etc.).`;

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

async function pickOcrEntry(): Promise<ModelRegistryEntry> {
  const list = await modelRegistrySearch({ modelType: "ocr" });
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
  const list = await modelRegistrySearch({
    modelType: "llm",
    filter: "Llama-3.2-1B",
  });
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
      langList: ["en"],
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

/** Lines that usually carry the final payable amount (avoid bare "total" — matches too many lines). */
const TOTAL_LINE_HINT =
  /receipt\s+total|invoice\s+total|total\s*due|balance\s*due|amount\s*due|grand\s*total|balance\s*owing|pay\s*this\s*amount|amount\s*owing|^\s*total\s*[:#]/im;

function amountsFromLine(line: string): number[] {
  const out: number[] = [];
  const re = /-?[\d,]+\.\d{2}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const v = parseFloat(m[0].replace(/,/g, ""));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** Label and amount are often split across consecutive OCR lines. */
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

/**
 * OCR often glues a bold `$` into digits so `$154.06` reads as `8154.06`. We recover `154.06` when:
 * - OCR has a `$…` amount matching the strip-leading-8 value, or
 * - That value appears on a total/balance block (incl. split across two OCR lines), or
 * - The merged wrong total appears on such a block (label + `8154.06`), or (last resort) `154.06` appears elsewhere.
 */
function fixTotalIfDollarSignMisreadAsEight(
  extraction: ReceiptExtraction,
  ocrText: string
): ReceiptExtraction {
  const tStr = extraction.total.toFixed(2);
  if (!tStr.startsWith("8")) return extraction;

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

  /** Large totals only: avoids rewriting small amounts like 8.50. */
  const weakOk = extraction.total >= 1_000;
  if (weakOk) {
    /** Total block shows the merged misread (e.g. "Receipt Total" + "8154.06") with no clean 154.06 in OCR. */
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
    /** Standalone correct cents elsewhere in OCR (line item, etc.). */
    const altEsc = alt.toFixed(2).replace(/\./g, "\\.");
    if (new RegExp(`\\b${altEsc}\\b`).test(ocrText)) {
      console.log("[extract] total correction:", extraction.total, "→", alt, "(leading 8; same amount elsewhere in OCR)");
      return { ...extraction, total: alt };
    }
  }

  return extraction;
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

export async function extractReceiptWithQvac(
  image: Buffer
): Promise<{ ocrText: string; extraction: ReceiptExtraction }> {
  const imageForOcr = await prepareImageForOcr(image);
  console.log("[extract] loading OCR model (first run can download; watch % logs)…");
  const ocrId = await ensureOcr();
  console.log("[extract] running OCR…");
  const { blocks } = ocr({
    modelId: ocrId,
    image: imageForOcr,
    options: { paragraph: true },
  });
  const ocrBlocks: OCRTextBlock[] = await blocks;
  const ocrText = ocrBlocks.map((b: OCRTextBlock) => b.text).join("\n");
  console.log("[extract] OCR chars:", ocrText.length);

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
          `OCR text from receipt:\n---\n${ocrText}\n---\n` +
          `Reply with JSON only. For "total", use the printed receipt total (major units). ` +
          `Treat $ only as a currency marker, never as the digit 8. ` +
          `If a printed total looks like 8154.xx but the same cents appear as xxx.xx after a $ or on the total line, use the smaller xxx.xx amount.`,
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
  extraction = fixTotalIfDollarSignMisreadAsEight(extraction, ocrText);
  console.log("[extract] done", extraction.merchant, extraction.total, extraction.currency);
  return { ocrText, extraction };
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
