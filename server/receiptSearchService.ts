/**
 * Second QVAC capability: local text embeddings over saved receipt text for semantic search.
 * Stores vectors on disk under `.rtc-data/` (gitignored).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  embed,
  loadModel,
  modelRegistrySearch,
  unloadModel,
  type ModelProgressUpdate,
  type ModelRegistryEntry,
} from "@qvac/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const DATA_PATH = path.join(rootDir, ".rtc-data", "receipt-embeddings.json");

type StoredReceipt = {
  id: string;
  at: string;
  merchant: string;
  total: number;
  category: string;
  preview: string;
  embedding: number[];
};

let embedModelId: string | null = null;

function registrySrc(entry: ModelRegistryEntry): string {
  return `registry://${entry.registrySource}/${entry.registryPath}`;
}

/** Prefer a real `.gguf` weight file — registry also lists tiny sidecars (e.g. `*.tensors.txt`) that break `gguf_file_load`. */
function isPrimaryEmbeddingGguf(entry: ModelRegistryEntry): boolean {
  const p = entry.registryPath.toLowerCase();
  if (!p.endsWith(".gguf")) return false;
  if (p.includes("tensors") || p.includes("readme")) return false;
  const shard = p.match(/-(\d{5})-of-(\d{5})\.gguf$/);
  if (shard && shard[1] !== "00001") return false;
  return true;
}

function rankEmbeddingCandidates(entries: ModelRegistryEntry[]): ModelRegistryEntry[] {
  const primaries = entries.filter(isPrimaryEmbeddingGguf);
  const pool = primaries.length > 0 ? primaries : entries.filter((e) => e.registryPath.toLowerCase().endsWith(".gguf"));
  if (pool.length === 0) {
    return [...entries];
  }
  const bulky = (p: string) =>
    /gte-large|e5-large|large.*fp16|multilingual-e5-large/i.test(p) ? 1 : 0;
  return [...pool].sort((a, b) => {
    const pa = a.registryPath.toLowerCase();
    const pb = b.registryPath.toLowerCase();
    const wa = bulky(pa) * 4 * 1024 ** 3 + a.expectedSize;
    const wb = bulky(pb) * 4 * 1024 ** 3 + b.expectedSize;
    return wa - wb;
  });
}

async function listEmbeddingLoadOrder(): Promise<ModelRegistryEntry[]> {
  const list = await modelRegistrySearch({ modelType: "embeddings" });
  if (!list.length) {
    throw new Error("No QVAC embedding models found in registry.");
  }
  const envPath = process.env.RTC_EMBEDDING_REGISTRY_PATH?.trim();
  if (envPath) {
    const hit = list.find(
      (e: ModelRegistryEntry) => e.registryPath === envPath || e.registryPath.endsWith(envPath)
    );
    if (hit) {
      const rest = rankEmbeddingCandidates(list).filter(
        (e: ModelRegistryEntry) => e.registryPath !== hit.registryPath
      );
      return [hit, ...rest];
    }
  }
  return rankEmbeddingCandidates(list);
}

async function ensureEmbedModel(): Promise<string> {
  if (embedModelId) return embedModelId;
  const candidates = await listEmbeddingLoadOrder();
  let lastErr: Error | null = null;
  for (const entry of candidates.slice(0, 12)) {
    try {
      console.log("[receipt-search] loading embedding model:", entry.name, entry.registryPath);
      const id = await loadModel({
        modelSrc: registrySrc(entry),
        modelType: "embeddings",
        modelConfig: {},
        onProgress: (p: ModelProgressUpdate) => {
          const pct = p.percentage;
          if (pct == null) return;
          if (pct === 100 || pct % 25 === 0) {
            console.log("[receipt-search] embedding model load", Math.round(pct), "%");
          }
        },
      });
      embedModelId = id;
      console.log("[receipt-search] embedding model ready:", entry.name, entry.registryPath);
      return id;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.warn("[receipt-search] embed load failed, trying next:", lastErr.message);
    }
  }
  throw lastErr ?? new Error("Could not load any QVAC embedding model for receipt search.");
}

function flattenEmbedding(e: unknown): number[] {
  if (!Array.isArray(e) || e.length === 0) return [];
  if (typeof (e as number[])[0] === "number") return e as number[];
  const inner = (e as number[][])[0];
  return Array.isArray(inner) ? inner : [];
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

function readStore(): StoredReceipt[] {
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const j = JSON.parse(raw) as unknown;
    return Array.isArray(j) ? (j as StoredReceipt[]) : [];
  } catch {
    return [];
  }
}

function writeStore(rows: StoredReceipt[]) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(rows, null, 2), "utf8");
}

export async function indexReceiptForSearch(row: {
  merchant: string;
  total: number;
  category: string;
  ocrText: string;
}): Promise<{ id: string; totalIndexed: number }> {
  const modelId = await ensureEmbedModel();
  const text = `${row.merchant} | ${row.total} | ${row.category} | ${row.ocrText}`.slice(0, 8000);
  const { embedding } = await embed({ modelId, text });
  const vec = flattenEmbedding(embedding);
  if (!vec.length) {
    throw new Error("QVAC returned an empty embedding.");
  }
  const store = readStore();
  const id = `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  store.push({
    id,
    at: new Date().toISOString(),
    merchant: row.merchant,
    total: row.total,
    category: row.category,
    preview: text.slice(0, 400),
    embedding: vec,
  });
  writeStore(store);
  console.log("[receipt-search] indexed", id, "total", store.length);
  return { id, totalIndexed: store.length };
}

export type ReceiptSearchHit = {
  id: string;
  at: string;
  merchant: string;
  total: number;
  category: string;
  preview: string;
  score: number;
};

export async function searchIndexedReceipts(
  query: string,
  limit = 8
): Promise<{ results: ReceiptSearchHit[] }> {
  const q = query.trim();
  if (!q) return { results: [] };
  const modelId = await ensureEmbedModel();
  const { embedding } = await embed({ modelId, text: q });
  const qvec = flattenEmbedding(embedding);
  if (!qvec.length) {
    throw new Error("QVAC returned an empty query embedding.");
  }
  const store = readStore();
  const results: ReceiptSearchHit[] = store
    .map((s) => ({
      id: s.id,
      at: s.at,
      merchant: s.merchant,
      total: s.total,
      category: s.category,
      preview: s.preview,
      score: cosineSimilarity(qvec, s.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { results };
}

export async function shutdownReceiptSearch(): Promise<void> {
  if (!embedModelId) return;
  try {
    await unloadModel({ modelId: embedModelId, clearStorage: false });
  } finally {
    embedModelId = null;
  }
}
