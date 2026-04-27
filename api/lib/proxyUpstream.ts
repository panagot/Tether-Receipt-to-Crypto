/**
 * Vercel serverless: forwards allowlisted /api/* to RTC_API_PROXY_TARGET (your tunnel or host).
 * No client rebuild when the tunnel URL changes — set RTC_API_PROXY_TARGET in Vercel and redeploy.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

const ALLOWED_PATHS = new Set([
  "/api/health",
  "/api/extract",
  "/api/pay",
  "/api/receipts/index",
  "/api/receipts/search",
]);

export const runtimeProxyConfig = {
  api: { bodyParser: false as const },
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

export async function proxyToRtcApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = (req as { url?: string }).url || "/";
  const pathname = rawUrl.split("?")[0] || "/";

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

  const upstreamUrl = base + rawUrl;

  const headers = new Headers();
  for (const [key, val] of Object.entries(req.headers)) {
    if (val == null) continue;
    const lk = key.toLowerCase();
    if (HOP_HEADERS.has(lk)) continue;
    headers.set(key, Array.isArray(val) ? val.join(", ") : val);
  }

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
