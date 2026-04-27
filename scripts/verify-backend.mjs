#!/usr/bin/env node
/**
 * Verifies the Receipt-to-Crypto API before testing the mobile UI.
 *
 * Usage:
 *   node scripts/verify-backend.mjs [apiBase] [optional-image-for-extract]
 *
 * Examples:
 *   node scripts/verify-backend.mjs
 *   node scripts/verify-backend.mjs http://127.0.0.1:3847
 *   node scripts/verify-backend.mjs https://xxxx.ngrok-free.app
 *   node scripts/verify-backend.mjs https://xxxx.ngrok-free.app C:\\path\\receipt.jpg
 *
 * Env: RTC_API_BASE (same as first arg)
 */
import fs from "node:fs";
import path from "node:path";

const base = (process.argv[2] || process.env.RTC_API_BASE || "http://127.0.0.1:3847").replace(/\/$/, "");
const imageArg = process.argv[3];

function fail(msg) {
  console.error("[FAIL]", msg);
  process.exit(1);
}

async function main() {
  console.log("API base:", base);
  const healthUrl = `${base}/api/health`;
  let res;
  try {
    res = await fetch(healthUrl, { signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    fail(`Cannot reach ${healthUrl}: ${e instanceof Error ? e.message : e}`);
  }
  const healthText = await res.text();
  console.log("GET /api/health → HTTP", res.status, "body length:", healthText.length);
  if (!res.ok) {
    console.error(healthText.slice(0, 500));
    fail("Health request not OK");
  }
  let healthJson;
  try {
    healthJson = JSON.parse(healthText);
  } catch {
    console.error(healthText.slice(0, 400));
    fail("Health response is not JSON (wrong URL or static HTML host — use VITE_API_BASE_URL on the client build).");
  }
  console.log("[OK] Health JSON:", JSON.stringify(healthJson));

  if (!imageArg) {
    console.log("\n[OK] Backend looks good. Add a JPEG path as 2nd arg to test /api/extract.");
    process.exit(0);
  }

  const filePath = path.resolve(imageArg);
  if (!fs.existsSync(filePath)) fail(`Image not found: ${filePath}`);

  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const boundary = "----rtcVerify" + Date.now();
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="receipt"; filename="${path.basename(filePath)}"\r\n` +
        `Content-Type: ${mime}\r\n\r\n`
    ),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const extractUrl = `${base}/api/extract`;
  console.log("\nPOST", extractUrl, "bytes:", buf.length);
  const eres = await fetch(extractUrl, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(Number(process.env.RTC_EXTRACT_TIMEOUT_MS || 900_000)),
  });
  const etext = await eres.text();
  console.log("POST /api/extract → HTTP", eres.status, "body length:", etext.length);
  let ej;
  try {
    ej = JSON.parse(etext);
  } catch {
    console.error(etext.slice(0, 500));
    fail("Extract response is not JSON");
  }
  if (!eres.ok) fail(ej.error || "extract HTTP error");
  console.log("[OK] Extract:", ej.extraction?.merchant, ej.extraction?.total, ej.extraction?.currency);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
