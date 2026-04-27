/**
 * Vercel serverless: forwards allowlisted /api/* to RTC_API_PROXY_TARGET (your tunnel or host).
 * No client rebuild when the tunnel URL changes — set RTC_API_PROXY_TARGET in Vercel and redeploy.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

const ALLOWED_PATHS = new Set([
  "/api/health",
  "/api/extract",
  "/api/pay",
  "/api/receipts/index",
  "/api/receipts/search",
]);

/** Only `maxDuration` in route files — `api.bodyParser` is for Pages router and can crash root `api/` handlers on Vercel. */
export const vercelRouteConfig = {
  maxDuration: 60,
};

function targetBase(): string | null {
  const t = process.env.RTC_API_PROXY_TARGET?.trim();
  if (!t) return null;
  return t.replace(/\/$/, "");
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer | string) => {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, "binary"));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Vercel may pass `req.url` as path+query or as an absolute URL — normalize to `/api/...?…`. */
function pathWithQueryFromReq(req: IncomingMessage): { pathname: string; pathWithQuery: string } {
  const raw = (req as { url?: string }).url || "/";
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

/** Avoid passing odd client / edge headers into `fetch()` (can throw or confuse upstream). */
function buildUpstreamHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
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
    const v = req.headers[name];
    if (v == null) continue;
    const s = Array.isArray(v) ? v.filter(Boolean).join(", ") : String(v);
    if (s) {
      try {
        headers.set(name, s);
      } catch {
        /* ignore invalid header */
      }
    }
  }
  return headers;
}

export async function proxyToRtcApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
          "Vercel proxy is not configured. Set environment variable RTC_API_PROXY_TARGET to your API origin (e.g. https://xxxx.ngrok-free.app, no trailing slash), then redeploy. Alternatively use VITE_API_BASE_URL at build time or ?rtc_api= on the client.",
      })
    );
    return;
  }

  const upstreamUrl = base + pathWithQuery;

  const headers = buildUpstreamHeaders(req);

  let body: Buffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await readBody(req);
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method || "GET",
      headers,
      body: body && body.length > 0 ? body : undefined,
    });
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: `upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      })
    );
    return;
  }

  res.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (lk === "transfer-encoding") return;
    try {
      res.setHeader(key, value);
    } catch {
      /* ignore invalid header names for Node */
    }
  });

  const buf = Buffer.from(await upstream.arrayBuffer());
  res.end(buf);
}

/** Wraps proxy; returns JSON 500 on unexpected errors so the function does not crash. */
export async function proxyToRtcApiSafe(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
