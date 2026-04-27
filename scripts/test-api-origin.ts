/**
 * Contract tests for client API origin helpers (no browser, no server).
 */
import assert from "node:assert/strict";
import { apiUrl, normalizeApiOrigin } from "../client/src/apiBase.ts";

function eq<T>(a: T, b: T, msg?: string) {
  assert.equal(a, b, msg);
}

eq(normalizeApiOrigin(""), "");
eq(normalizeApiOrigin("   "), "");
eq(normalizeApiOrigin("https://foo.ngrok-free.app"), "https://foo.ngrok-free.app");
eq(normalizeApiOrigin("https://foo.ngrok-free.app/"), "https://foo.ngrok-free.app");
eq(normalizeApiOrigin("http://127.0.0.1:3847"), "http://127.0.0.1:3847");
eq(normalizeApiOrigin("foo.ngrok-free.app"), "https://foo.ngrok-free.app");
eq(normalizeApiOrigin("FOO.EXAMPLE.COM"), "https://foo.example.com");
eq(normalizeApiOrigin("https://api.example.com/v1"), "https://api.example.com");

eq(apiUrl("/api/health"), "/api/health");

console.log("[OK] test-api-origin: all assertions passed");
