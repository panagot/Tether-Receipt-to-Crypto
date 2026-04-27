#!/usr/bin/env node
/**
 * Verifies the Receipt-to-Crypto API before testing the mobile UI.
 *
 * Usage:
 *   node scripts/verify-backend.mjs
 *   node scripts/verify-backend.mjs [apiBase]
 *   node scripts/verify-backend.mjs [apiBase] [path-to-receipt-image]
 *   node scripts/verify-backend.mjs [path-to-receipt-image]   # uses RTC_API_BASE or http://127.0.0.1:3847
 *
 * Examples:
 *   node scripts/verify-backend.mjs
 *   node scripts/verify-backend.mjs http://127.0.0.1:3847
 *   node scripts/verify-backend.mjs https://xxxx.ngrok-free.app
 *   node scripts/verify-backend.mjs https://xxxx.ngrok-free.app C:\\path\\receipt.jpg
 *   node scripts/verify-backend.mjs test/fixtures/tiny-receipt.jpg
 *
 * Env: RTC_API_BASE (default API origin when first arg is an image path only)
 */
import fs from "node:fs";
import path from "node:path";

const defaultBase = (process.env.RTC_API_BASE || "http://127.0.0.1:3847").replace(/\/$/, "");

function looksHttp(s) {
  return /^https?:\/\//i.test(s);
}

function looksImageFile(s) {
  if (!s) return false;
  if (!/\.(jpe?g|png|webp)$/i.test(s)) return false;
  const abs = path.resolve(s);
  try {
    return fs.existsSync(abs) && fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

const arg2 = process.argv[2];
const arg3 = process.argv[3];

let base = defaultBase;
let imageArg;

if (!arg2) {
  /* defaults above */
} else if (looksHttp(arg2)) {
  base = arg2.replace(/\/$/, "");
  imageArg = arg3;
} else if (looksImageFile(arg2) && !arg3) {
  imageArg = arg2;
} else if (arg3) {
  console.error("[FAIL] With two arguments, the first must be an http(s) API base URL.");
  process.exit(1);
} else {
  console.error(
    "[FAIL] Unrecognized first argument:",
    arg2,
    "— use an http(s) base URL, or a path to a .jpg/.png/.webp receipt file (with default base)."
  );
  process.exit(1);
}

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
    console.log(
      "\n[OK] Backend looks good. To test /api/extract: pass `http(s)://base path/to/receipt.jpg` " +
        "or only a receipt path (uses RTC_API_BASE or http://127.0.0.1:3847), e.g. `test/fixtures/tiny-receipt.jpg`."
    );
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
