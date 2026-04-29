#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const apiBase = (process.argv[2] || "http://127.0.0.1:3847").replace(/\/$/, "");
const here = path.join(process.cwd(), "test", "online-receipts");
const manifestPath = path.join(here, "manifest.json");
const reportJsonPath = path.join(here, "evaluation-report.json");
const reportMdPath = path.join(here, "evaluation-report.md");
const tolerance = 0.05;

const expectedByFile = {
  "sroie-001.jpg": { total: 60.3, currency: "MYR", note: "Ground truth from SROIE key labels." },
  "sroie-002.jpg": { total: 33.9, currency: "MYR", note: "Ground truth from SROIE key labels." },
  "sroie-003.jpg": { total: 80.9, currency: "MYR", note: "Ground truth from SROIE key labels." },
  "sroie-004.jpg": { total: 30.9, currency: "MYR", note: "Ground truth from SROIE key labels." },
  "sroie-005.jpg": { total: 31.0, currency: "MYR", note: "Ground truth from SROIE key labels." },
  "sroie-006.jpg": { total: 327.0, currency: "MYR", note: "Ground truth from SROIE key labels." },
  "sroie-007.jpg": { total: 20.0, currency: "MYR", note: "Ground truth from SROIE key labels." },
  "sroie-008.jpg": { total: 112.45, currency: "MYR", note: "Ground truth from SROIE key labels." },
  "invoice-barlow.png": { total: null, currency: null, note: "No machine-readable ground-truth label found; best-effort visual comparison only." },
  "invoice-sarabun.png": { total: null, currency: null, note: "No machine-readable ground-truth label found; best-effort visual comparison only." },
};

function mimeFor(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function buildMultipart(fileName, buf) {
  const boundary = "----rtcBatchBoundary" + Date.now() + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="receipt"; filename="${fileName}"\r\n` +
        `Content-Type: ${mimeFor(fileName)}\r\n\r\n`
    ),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { boundary, body };
}

async function waitForHealth() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${apiBase}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`API not healthy at ${apiBase}/api/health`);
}

function normalizeCurrency(v) {
  return typeof v === "string" ? v.trim().toUpperCase() : null;
}

function evaluate(extracted, expected) {
  const extTotal = typeof extracted.total === "number" ? extracted.total : Number(extracted.total);
  const extCurrency = normalizeCurrency(extracted.currency);
  const expectedTotal = expected.total;
  const expectedCurrency = normalizeCurrency(expected.currency);

  const hasExpected = typeof expectedTotal === "number" && typeof expectedCurrency === "string";
  if (!hasExpected) {
    return { pass: null, totalMatch: null, currencyMatch: null };
  }

  const totalMatch = Number.isFinite(extTotal) && Math.abs(extTotal - expectedTotal) <= tolerance;
  const currencyMatch = extCurrency === expectedCurrency;
  return {
    pass: totalMatch && currencyMatch,
    totalMatch,
    currencyMatch,
  };
}

await waitForHealth();

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const results = [];

for (const sample of manifest) {
  const fileName = sample.file;
  const filePath = path.join(here, fileName);
  const expected = expectedByFile[fileName] || { total: null, currency: null, note: "No expected data." };
  let status = "ok";
  let httpStatus = null;
  let extraction = null;
  let error = null;

  try {
    const buf = fs.readFileSync(filePath);
    const { boundary, body } = buildMultipart(fileName, buf);
    const res = await fetch(`${apiBase}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(900000),
    });
    httpStatus = res.status;
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      status = "invalid-json";
      error = text.slice(0, 500);
    }
    if (json) {
      if (!res.ok) {
        status = "http-error";
        error = json.error || text.slice(0, 500);
      } else {
        const ex = json.extraction || {};
        extraction = {
          merchant: ex.merchant ?? null,
          total: ex.total ?? null,
          currency: ex.currency ?? null,
          suggestedUsdtUsd: json.suggestedUsdtUsd ?? ex.suggestedUsdtUsd ?? null,
        };
      }
    }
  } catch (e) {
    status = "request-error";
    error = e instanceof Error ? e.message : String(e);
  }

  const evalResult = extraction ? evaluate(extraction, expected) : { pass: false, totalMatch: false, currencyMatch: false };
  const notes = [];
  if (expected.note) notes.push(expected.note);
  if (status !== "ok") notes.push(`Extraction failed: ${status}${error ? ` (${error})` : ""}`);
  else {
    if (evalResult.pass === false) {
      if (evalResult.totalMatch === false) notes.push("Total mismatch.");
      if (evalResult.currencyMatch === false) notes.push("Currency mismatch.");
    }
    if (evalResult.pass === null) notes.push("Expected total/currency unavailable, marked as partial.");
  }

  results.push({
    fileName,
    sourceUrl: sample.url,
    status,
    httpStatus,
    extraction,
    expected: {
      total: expected.total,
      currency: expected.currency,
    },
    evaluation: evalResult,
    notes,
  });
}

const summary = {
  totalSamples: results.length,
  accurate: results.filter((r) => r.evaluation.pass === true).length,
  partial: results.filter((r) => r.evaluation.pass === null).length,
  failed: results.filter((r) => r.evaluation.pass === false).length,
  successResponses: results.filter((r) => r.status === "ok").length,
  nonOkResponses: results.filter((r) => r.status !== "ok").length,
};

const report = {
  apiBase,
  tolerance,
  generatedAt: new Date().toISOString(),
  summary,
  results,
};

fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2));

const lines = [];
lines.push("# Online Receipts Batch Evaluation");
lines.push("");
lines.push(`- API base: \`${apiBase}\``);
lines.push(`- Samples: ${summary.totalSamples}`);
lines.push(`- Accurate (total+currency): ${summary.accurate}`);
lines.push(`- Partial (missing expected): ${summary.partial}`);
lines.push(`- Failed: ${summary.failed}`);
lines.push(`- Success HTTP responses: ${summary.successResponses}`);
lines.push("");
lines.push("| file | status | merchant | extracted total | extracted currency | expected total | expected currency | pass/fail | notes |");
lines.push("|---|---|---|---:|---|---:|---|---|---|");
for (const r of results) {
  lines.push(
    `| ${r.fileName} | ${r.status} | ${(r.extraction?.merchant || "").replaceAll("|", "\\|")} | ${r.extraction?.total ?? ""} | ${r.extraction?.currency ?? ""} | ${r.expected.total ?? ""} | ${r.expected.currency ?? ""} | ${r.evaluation.pass === null ? "partial" : r.evaluation.pass ? "pass" : "fail"} | ${(r.notes || []).join("; ").replaceAll("|", "\\|")} |`
  );
}
lines.push("");
fs.writeFileSync(reportMdPath, lines.join("\n"));

console.log(`Wrote ${reportJsonPath}`);
console.log(`Wrote ${reportMdPath}`);
console.log(JSON.stringify(summary, null, 2));
