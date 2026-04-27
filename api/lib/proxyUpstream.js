/**
 * Vercel serverless: forwards allowlisted /api/* to RTC_API_PROXY_TARGET.
 * Plain JS — avoids TS/bundler edge cases with dynamic api routes on Vercel.
 */

const ALLOWED_PATHS = new Set([
  "/api/health",
  "/api/extract",
  "/api/pay",
  "/api/receipts/index",
  "/api/receipts/search",
]);

export const vercelRouteConfig = {
  maxDuration: 60,
};

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

function buildUpstreamHeaders(req) {
  const headers = new Headers();
  const h = req && req.headers;
  if (!h || typeof h !== "object") return headers;

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
    if (s) {
      try {
        headers.set(name, s);
      } catch {
        /* ignore */
      }
    }
  }
  return headers;
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
  const headers = buildUpstreamHeaders(req);

  let body;
  const method = (req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    body = await readBody(req);
  }

  let upstream;
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
      /* ignore */
    }
  });

  const buf = Buffer.from(await upstream.arrayBuffer());
  res.end(buf);
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
