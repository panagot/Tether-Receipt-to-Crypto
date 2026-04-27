#!/usr/bin/env node
/**
 * Reads the local ngrok agent API and prints the exact Vercel env Key + Value to paste.
 * Requires: ngrok running (`ngrok http 3847`) while your API listens on 3847.
 *
 * Usage: npm run vercel:env-snippet
 */
const NGROK_API = "http://127.0.0.1:4040/api/tunnels";

function originFromPublicUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function addrMatches3847(addr) {
  if (!addr) return false;
  const s = String(addr).toLowerCase();
  return (
    s.includes(":3847") ||
    s === "3847" ||
    s.includes("localhost:3847") ||
    s.includes("127.0.0.1:3847")
  );
}

async function main() {
  let res;
  try {
    res = await fetch(NGROK_API, { signal: AbortSignal.timeout(3000) });
  } catch {
    console.error(`
Could not reach the ngrok web interface at ${NGROK_API}.

Do this on your PC, then run this script again:
  1) Terminal A:  npm run dev     (API + UI, or npm run dev:server for API only on port 3847)
  2) Terminal B:  ngrok http 3847
  3) Terminal C:  npm run vercel:env-snippet
`);
    process.exit(1);
  }

  if (!res.ok) {
    console.error("[FAIL] ngrok API HTTP", res.status);
    process.exit(1);
  }

  const data = await res.json();
  const tunnels = Array.isArray(data.tunnels) ? data.tunnels : [];

  const candidates = tunnels
    .map((t) => ({
      https: t.public_url && String(t.public_url).startsWith("https:") ? t.public_url : null,
      addr: t.config?.addr ?? t.config?.addr_string ?? "",
    }))
    .filter((t) => t.https);

  if (candidates.length === 0) {
    console.error("[FAIL] No https tunnels found. Start: ngrok http 3847");
    process.exit(1);
  }

  const preferred =
    candidates.find((c) => addrMatches3847(c.addr)) ?? candidates[0];
  const origin = originFromPublicUrl(preferred.https);
  if (!origin) {
    console.error("[FAIL] Could not parse tunnel URL:", preferred.https);
    process.exit(1);
  }

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Copy into Vercel → Project → Settings → Environment Variables
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Key:     RTC_API_PROXY_TARGET

  Value:   ${origin}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Then: Save → Deployments → … → Redeploy (or push a commit).
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
  if (!addrMatches3847(preferred.addr)) {
    console.warn(
      "[WARN] Tunnel config may not point at port 3847. In ngrok dashboard/CLI, use: ngrok http 3847\n"
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
