/** Parse `fetch` body as JSON; surface clear errors when the server returns HTML or plain text (e.g. Vercel 404). */
export async function parseJsonOrThrow<T = unknown>(r: Response): Promise<T> {
  const text = await r.text();
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(`Empty response (HTTP ${r.status}).`);
  }
  const lower = trimmed.slice(0, 64).toLowerCase();
  if (lower.startsWith("<!doctype") || lower.startsWith("<html") || trimmed.startsWith("<")) {
    throw new Error(
      "The server returned a web page instead of JSON — usually there is no API at this URL. " +
        "Run the Receipt-to-Crypto backend (e.g. npm run dev) or point the UI at your API host."
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    if (
      r.status === 404 &&
      !trimmed.startsWith("{") &&
      !trimmed.startsWith("[") &&
      (/not_found|could not be found|the page could not be found/i.test(trimmed) || trimmed.length < 500)
    ) {
      throw new Error(
        "HTTP 404 — this page is still calling /api on the static host (e.g. Vercel). " +
          "Fix: (1) In Vercel → Environment Variables set VITE_API_BASE_URL to your API origin (https, no trailing slash) and redeploy, " +
          "or (2) without redeploying, open this app once as …?rtc_api=https://your-ngrok-host — it is saved for this browser session."
      );
    }
    const preview = trimmed.replace(/\s+/g, " ").slice(0, 160);
    throw new Error(`Invalid JSON (HTTP ${r.status}): ${preview}${trimmed.length > 160 ? "…" : ""}`);
  }
}
