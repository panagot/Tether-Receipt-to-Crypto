/**
 * QVAC: OCR (registry) + small LLM JSON extraction. USE_MOCK_AI skips model load.
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
import { ReceiptExtractionSchema, type ReceiptExtraction } from "./schema.js";

const SYSTEM_PROMPT = `You extract structured data from retail receipt OCR text.
Return ONLY valid JSON (no markdown) with keys:
merchant (string), total (number, major units e.g. 12.34), currency (ISO string), category (one of: food, transport, retail, services, utilities, healthcare, other), confidence (0-1), notes (optional string).
If unsure, lower confidence and explain in notes.`;

let ocrModelId: string | null = null;
let llmModelId: string | null = null;

function registrySrc(entry: ModelRegistryEntry): string {
  return `registry://${entry.registrySource}/${entry.registryPath}`;
}

function onDownloadProgress(label: string) {
  return (p: ModelProgressUpdate) => {
    if (p.percentage != null && p.percentage % 10 === 0) {
      console.log(`[QVAC ${label}]`, p.percentage, "%");
    }
  };
}

export function useMockAi(): boolean {
  return process.env.USE_MOCK_AI === "true" || process.env.USE_MOCK_AI === "1";
}

async function pickOcrEntry(): Promise<ModelRegistryEntry> {
  const list = await modelRegistrySearch({ modelType: "ocr" });
  const hit =
    list.find((m: ModelRegistryEntry) => m.name.includes("LATIN_RECOGNIZER_1")) ||
    list.find((m: ModelRegistryEntry) => m.engine === "onnx-ocr") ||
    list[0];
  if (!hit) throw new Error("No OCR models returned from QVAC registry.");
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
      useGPU: true,
      timeout: 120_000,
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
    modelConfig: { ctx_size: 4096, temp: 0.2, predict: 512 },
    onProgress: onDownloadProgress("LLM"),
  });
  llmModelId = id;
  return id;
}

function parseJsonFromLlm(raw: string): unknown {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : trimmed;
  return JSON.parse(body) as unknown;
}

export async function extractReceiptWithQvac(
  image: Buffer
): Promise<{ ocrText: string; extraction: ReceiptExtraction }> {
  if (useMockAi()) {
    const ocrText = "MOCK STORE\n123 Main St\nTOTAL 47.89 USD\nTHANK YOU";
    const extraction = ReceiptExtractionSchema.parse({
      merchant: "Mock Store",
      total: 47.89,
      currency: "USD",
      category: "retail",
      confidence: 0.5,
      notes: "USE_MOCK_AI=true — set to false for real QVAC.",
    });
    return { ocrText, extraction };
  }

  const ocrId = await ensureOcr();
  const { blocks } = ocr({
    modelId: ocrId,
    image,
    options: { paragraph: true },
  });
  const ocrBlocks: OCRTextBlock[] = await blocks;
  const ocrText = ocrBlocks.map((b: OCRTextBlock) => b.text).join("\n");

  const llmId = await ensureLlm();
  const { text } = completion({
    modelId: llmId,
    stream: false,
    history: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `OCR text from receipt:\n---\n${ocrText}\n---\nReply with JSON only.`,
      },
    ],
    generationParams: { temp: 0.1, predict: 400 },
  });
  const raw = await text;
  let parsed: unknown;
  try {
    parsed = parseJsonFromLlm(raw);
  } catch {
    throw new Error(`LLM did not return valid JSON. Raw (truncated): ${raw.slice(0, 500)}`);
  }
  const extraction = ReceiptExtractionSchema.parse(parsed);
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
