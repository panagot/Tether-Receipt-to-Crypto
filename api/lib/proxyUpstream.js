/**
 * Vercel serverless: forwards allowlisted /api/* to RTC_API_PROXY_TARGET.
 * Uses node:http / node:https only (no global fetch / Web Headers — avoids runtime crashes).
 */

import * as http from "node:http";
import * as https from "node:https";

const ALLOWED_PATHS = new Set([
  "/api/health",
  "/api/extract",
  "/api/pay",
  "/api/receipts/index",
  "/api/receipts/search",
]);

function targetBase() {
  const t = process.env.RTC_API_PROXY_TARGET?.trim();
  if (!t) return null;
  return t.replace(/\/$/, "");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, "binary"));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function pathWithQueryFromReq(req) {
  const raw = (req && typeof req.url === "string" && req.url) || "/";
  if (raw.startsWith("/")) {
    const pathname = raw.split("?")[0] || "/";
    return { pathname, pathWithQuery: raw };
  }
  try {
    const u = new URL(raw);
    return {
      pathname: u.pathname,
      pathWithQuery: u.pathname + (u.search || ""),
    };
  } catch {
    return { pathname: "/", pathWithQuery: "/api/health" };
  }
}

/** Plain object for node client request (not Web Headers). */
function buildUpstreamHeaders(req) {
  const out = {};
  const h = req && req.headers;
  if (!h || typeof h !== "object") return out;

  const pass = [
    "content-type",
    "authorization",
    "accept",
    "accept-encoding",
    "accept-language",
    "user-agent",
    "x-request-id",
  ];
  for (const name of pass) {
    const v = h[name];
    if (v == null) continue;
    const s = Array.isArray(v) ? v.filter(Boolean).join(", ") : String(v);
    if (s) out[name] = s;
  }
  return out;
}

function nodeUpstreamRequest(urlStr, method, headerObj, bodyBuf) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const defaultPort = u.protocol === "https:" ? 443 : 80;
    const port = u.port ? Number(u.port) : defaultPort;

    const opts = {
      hostname: u.hostname,
      port,
      path: u.pathname + (u.search || ""),
      method: method || "GET",
      headers: headerObj,
    };

    const req2 = lib.request(opts, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => {
        resolve({
          statusCode: resp.statusCode || 502,
          headers: resp.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req2.on("error", reject);
    if (bodyBuf && bodyBuf.length > 0) req2.write(bodyBuf);
    req2.end();
  });
}

export async function proxyToRtcApi(req, res) {
  const { pathname, pathWithQuery } = pathWithQueryFromReq(req);

  if (!pathname.startsWith("/api/")) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "expected /api/*" }));
    return;
  }

  if (!ALLOWED_PATHS.has(pathname)) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const base = targetBase();
  if (!base) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error:
          "Vercel proxy is not configured. Set RTC_API_PROXY_TARGET (https origin, no trailing slash), then redeploy.",
      })
    );
    return;
  }

  const upstreamUrl = base + pathWithQuery;
  const headerObj = buildUpstreamHeaders(req);

  let body;
  const method = (req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    body = await readBody(req);
  }

  let result;
  try {
    result = await nodeUpstreamRequest(
      upstreamUrl,
      req.method || "GET",
      headerObj,
      body && body.length > 0 ? body : null
    );
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: `upstream request failed: ${e instanceof Error ? e.message : String(e)}`,
      })
    );
    return;
  }

  res.statusCode = result.statusCode;
  for (const key of Object.keys(result.headers)) {
    const v = result.headers[key];
    if (v == null) continue;
    const lk = key.toLowerCase();
    if (lk === "transfer-encoding") continue;
    try {
      res.setHeader(key, v);
    } catch {
      /* ignore invalid / duplicate */
    }
  }

  res.end(result.body);
}

export async function proxyToRtcApiSafe(req, res) {
  try {
    await proxyToRtcApi(req, res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (res.headersSent) {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "proxy crash", detail: msg }));
  }
}
