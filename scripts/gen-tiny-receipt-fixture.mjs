#!/usr/bin/env node
/**
 * Regenerates test/fixtures/tiny-receipt.jpg (small valid JPEG for scripts and CI).
 * Usage: node scripts/gen-tiny-receipt-fixture.mjs
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const out = path.join(process.cwd(), "test", "fixtures", "tiny-receipt.jpg");
fs.mkdirSync(path.dirname(out), { recursive: true });
await sharp({
  create: {
    width: 120,
    height: 160,
    channels: 3,
    background: { r: 248, g: 250, b: 252 },
  },
})
  .jpeg({ quality: 82 })
  .toFile(out);
console.log("[OK] wrote", out, fs.statSync(out).size, "bytes");
