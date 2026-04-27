/**
 * Tests parseJsonOrThrow for Vercel-style non-JSON 404 bodies.
 */
import assert from "node:assert/strict";
import { parseJsonOrThrow } from "../client/src/apiJson.ts";

async function vercelPlain404() {
  const body = "The page could not be found NOT_FOUND fra1::szpzj-test";
  const r = new Response(body, { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  try {
    await parseJsonOrThrow(r);
    assert.fail("expected throw");
  } catch (e) {
    assert.ok(e instanceof Error);
    assert.match(
      e.message,
      /404|Vercel|rtc_api|VITE_API_BASE_URL|redeploy/i,
      `message should mention fix: ${e.message}`
    );
  }
}

async function validJson() {
  const r = new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } });
  const j = await parseJsonOrThrow<{ ok: boolean }>(r);
  assert.equal(j.ok, true);
}

async function html404() {
  const r = new Response("<!DOCTYPE html><html><body>404</body></html>", {
    status: 404,
    headers: { "Content-Type": "text/html" },
  });
  try {
    await parseJsonOrThrow(r);
    assert.fail("expected throw");
  } catch (e) {
    assert.ok(e instanceof Error);
    assert.match(e.message, /web page|JSON/i);
  }
}

/** Real API may return JSON body on 404 — do not treat as Vercel plain-text. */
async function json404() {
  const r = new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
  const j = await parseJsonOrThrow<{ error: string }>(r);
  assert.equal(j.error, "not found");
}

await vercelPlain404();
await validJson();
await html404();
await json404();
console.log("[OK] test-api-json: all assertions passed");
