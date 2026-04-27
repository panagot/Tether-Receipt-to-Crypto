#!/usr/bin/env node
/**
 * Verifies a receipt file exists and looks like JPEG/PNG/WebP from magic bytes.
 * Usage: node scripts/check-receipt-file.mjs [path-to-image]
 */
import fs from "node:fs";
import path from "node:path";

const defaultFixture = path.join(process.cwd(), "test", "fixtures", "tiny-receipt.jpg");
const p = path.resolve(process.argv[2] || defaultFixture);

if (!fs.existsSync(p)) {
  console.error("[FAIL] File not found:", p);
  process.exit(1);
}

const st = fs.statSync(p);
const buf = fs.readFileSync(p);
const head = buf.subarray(0, 12);
const hex = [...head].map((b) => b.toString(16).padStart(2, "0")).join(" ");

let kind = "unknown";
if (buf[0] === 0xff && buf[1] === 0xd8) kind = "jpeg";
else if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) kind = "png";
else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)
  kind = "webp";

console.log("[OK] path:", p);
console.log("     size:", st.size, "bytes");
console.log("     magic:", hex);
console.log("     kind:", kind);

if (!["jpeg", "png", "webp"].includes(kind)) {
  console.error("[FAIL] Not JPEG/PNG/WebP magic — browser and API may reject.");
  process.exit(2);
}
