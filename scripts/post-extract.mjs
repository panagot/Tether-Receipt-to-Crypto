#!/usr/bin/env node
/**
 * POSTs a local image to the running API /api/extract (same as the browser).
 * Usage: node scripts/post-extract.mjs [path-to-image] [apiBase]
 * Default apiBase: http://127.0.0.1:3847
 */
import fs from "node:fs";
import path from "node:path";

const filePath = path.resolve(process.argv[2] || "C:\\Users\\panag\\Desktop\\Receipt-template-example.jpg");
const base = (process.argv[3] || "http://127.0.0.1:3847").replace(/\/$/, "");

if (!fs.existsSync(filePath)) {
  console.error("[FAIL] File not found:", filePath);
  process.exit(1);
}

const buf = fs.readFileSync(filePath);
const ext = path.extname(filePath).toLowerCase();
const mime =
  ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";

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

const url = `${base}/api/extract`;
console.log("[POST]", url, "bytes:", buf.length, "mime:", mime);

const timeoutMs = Number(process.env.RTC_EXTRACT_TIMEOUT_MS || 900_000);
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  body,
  signal: AbortSignal.timeout(timeoutMs),
});

const text = await res.text();
console.log("[HTTP]", res.status);
try {
  const j = JSON.parse(text);
  if (j.error) console.log("[JSON error]", j.error);
  else console.log("[OK] merchant:", j.extraction?.merchant, "total:", j.extraction?.total);
} catch {
  console.log("[body]", text.slice(0, 500));
}

if (!res.ok) process.exit(3);
