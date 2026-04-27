#!/usr/bin/env node
/**
 * Waits for /api/health then POSTs a receipt image to /api/extract, with retries.
 * Usage: node scripts/smoke-extract-receipt.mjs [imagePath] [apiBase]
 */
import fs from "node:fs";
import path from "node:path";

const defaultFixture = path.join(process.cwd(), "test", "fixtures", "tiny-receipt.jpg");
const filePath = path.resolve(process.argv[2] || defaultFixture);
const base = (process.argv[3] || "http://127.0.0.1:3847").replace(/\/$/, "");
const MAX_ATTEMPTS = Number(process.env.RTC_SMOKE_ATTEMPTS || 5);
const BETWEEN_MS = Number(process.env.RTC_SMOKE_PAUSE_MS || 4000);
/** First run can download models + run OCR + LLM. */
const EXTRACT_TIMEOUT_MS = Number(process.env.RTC_EXTRACT_TIMEOUT_MS || 900_000);

if (!fs.existsSync(filePath)) {
  console.error("[FAIL] File not found:", filePath);
  process.exit(1);
}

async function waitHealth() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        console.log("[OK] API health:", await r.text());
        return;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("API did not become ready in time");
}

const buf = fs.readFileSync(filePath);
const ext = path.extname(filePath).toLowerCase();
const mime =
  ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";

function buildBody() {
  const boundary = "----rtcBoundary" + Date.now();
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="receipt"; filename="${path.basename(filePath)}"\r\n` +
        `Content-Type: ${mime}\r\n\r\n`
    ),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { boundary, body };
}

await waitHealth();

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  console.log(`\n--- extract attempt ${attempt}/${MAX_ATTEMPTS} (timeout ${EXTRACT_TIMEOUT_MS}ms) ---`);
  const { boundary, body } = buildBody();
  try {
    const res = await fetch(`${base}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    });
    const text = await res.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      console.error("[FAIL] Non-JSON response", res.status, text.slice(0, 400));
      await new Promise((r) => setTimeout(r, BETWEEN_MS));
      continue;
    }
    if (!res.ok) {
      console.error("[FAIL] HTTP", res.status, j.error || text.slice(0, 400));
      await new Promise((r) => setTimeout(r, BETWEEN_MS));
      continue;
    }
    if (j.extraction) {
      console.log("[SUCCESS]", JSON.stringify(j.extraction, null, 2));
      console.log("OCR chars:", (j.ocrText || "").length);
      process.exit(0);
    }
    console.error("[FAIL] Missing extraction", j);
  } catch (e) {
    console.error("[FAIL] Request error:", e instanceof Error ? e.message : e);
  }
  await new Promise((r) => setTimeout(r, BETWEEN_MS));
}

console.error("[FAIL] All attempts exhausted");
process.exit(1);
