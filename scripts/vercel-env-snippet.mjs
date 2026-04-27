#!/usr/bin/env node
/**
 * Prints the exact Vercel env block for RTC_API_PROXY_TARGET.
 *
 * Tries in order:
 *   1) RTC_PUBLIC_API_URL or RTC_API_PROXY_TARGET (already known URL — just normalize + print)
 *   2) ngrok agent API at http://127.0.0.1:4040/api/tunnels
 *   3) Spawn cloudflared quick tunnel (trycloudflare.com) — no ngrok account needed
 *
 * Env:
 *   RTC_LOCAL_API_PORT — default 3847
 *   RTC_CLOUDFLARED_BIN — path to cloudflared if not on PATH
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

function resolveCloudflaredBin() {
  const fromEnv = process.env.RTC_CLOUDFLARED_BIN?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform === "win32") {
    const candidates = [
      String.raw`C:\Program Files (x86)\cloudflared\cloudflared.exe`,
      String.raw`C:\Program Files\cloudflared\cloudflared.exe`,
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  } else {
    for (const p of ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"]) {
      if (existsSync(p)) return p;
    }
  }
  return "cloudflared";
}

const PORT = Number(process.env.RTC_LOCAL_API_PORT || 3847);
const LOCAL = `http://127.0.0.1:${PORT}`;
const NGROK_API = "http://127.0.0.1:4040/api/tunnels";
const TRYCF_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

function originFromAny(input) {
  if (!input || typeof input !== "string") return null;
  const s = input.trim().replace(/\/$/, "");
  try {
    const u = new URL(s.includes("://") ? s : `https://${s}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function printBlock(origin) {
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Vercel → Project → Settings → Environment Variables → Add
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Key:     RTC_API_PROXY_TARGET

  Value:   ${origin}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Save → Redeploy the project (or push a commit).
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

async function localApiUp() {
  try {
    const r = await fetch(`${LOCAL}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

function tryEnvUrl() {
  const raw =
    process.env.RTC_PUBLIC_API_URL?.trim() ||
    process.env.RTC_API_PROXY_TARGET?.trim() ||
    "";
  if (!raw) return null;
  const o = originFromAny(raw);
  if (!o) {
    console.error("[FAIL] Could not parse RTC_PUBLIC_API_URL / RTC_API_PROXY_TARGET:", raw);
    process.exit(1);
  }
  return o;
}

function addrMatches3847(addr) {
  if (!addr) return false;
  const s = String(addr).toLowerCase();
  return (
    s.includes(":3847") ||
    s === "3847" ||
    s.includes("localhost:3847") ||
    s.includes("127.0.0.1:3847") ||
    s.includes(`:${PORT}`)
  );
}

async function tryNgrok() {
  let res;
  try {
    res = await fetch(NGROK_API, { signal: AbortSignal.timeout(2500) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = await res.json();
  const tunnels = Array.isArray(data.tunnels) ? data.tunnels : [];
  const candidates = tunnels
    .map((t) => ({
      https: t.public_url && String(t.public_url).startsWith("https:") ? t.public_url : null,
      addr: t.config?.addr ?? t.config?.addr_string ?? "",
    }))
    .filter((t) => t.https);
  if (candidates.length === 0) return null;
  const preferred = candidates.find((c) => addrMatches3847(c.addr)) ?? candidates[0];
  return originFromAny(preferred.https);
}

async function tryCloudflaredQuickTunnel() {
  const bin = resolveCloudflaredBin();
  if (!(await localApiUp())) {
    console.error(`
[FAIL] Nothing is responding at ${LOCAL}/api/health.

Start the API first, then run this script again:
  npm run dev:server
  # or
  npm run dev
`);
    process.exit(1);
  }

  console.log("[…] Starting Cloudflare quick tunnel (no account). First run may download the binary if cloudflared is installed…\n");

  const child = spawn(bin, ["tunnel", "--url", LOCAL], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let spawnErr = null;
  child.on("error", (err) => {
    spawnErr = err;
  });

  let combined = "";
  let found = null;

  const onChunk = (chunk) => {
    combined += chunk.toString();
    const m = combined.match(TRYCF_RE);
    if (m && m.length) {
      found = m[m.length - 1].replace(/\/$/, "");
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  const deadline = Date.now() + 35_000;
  while (!found && Date.now() < deadline) {
    if (spawnErr) {
      console.error("[FAIL] Could not start cloudflared:", spawnErr.message);
      console.error("\nInstall (Windows): winget install Cloudflare.cloudflared\n");
      process.exit(1);
    }
    if (child.exitCode != null) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  child.stdout?.off("data", onChunk);
  child.stderr?.off("data", onChunk);

  if (!found) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    console.error(`
[FAIL] No trycloudflare.com URL appeared within 35s (or cloudflared exited).

Install Cloudflare Tunnel (Windows):
  winget install Cloudflare.cloudflared

Then close this terminal, open a new one, and run:
  npm run vercel:env-snippet

Or use ngrok after: ngrok config add-authtoken <token>   then   ngrok http ${PORT}
`);
    process.exit(1);
  }

  const origin = originFromAny(found);
  printBlock(origin);

  const ok = await (async () => {
    try {
      const r = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(12_000) });
      return r.ok;
    } catch {
      return false;
    }
  })();
  if (!ok) {
    console.warn(
      "[WARN] Could not GET /api/health through the tunnel yet (it can take a few seconds). If it keeps failing, wait and retry in a browser.\n"
    );
  } else {
    console.log("[OK] Tunnel responds at /api/health\n");
  }

  console.log(
    "→ Copy the Value above into Vercel, then press Ctrl+C here to stop the tunnel.\n"
  );

  const stop = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 400);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await new Promise((resolve) => child.once("exit", resolve));
}

async function main() {
  const fromEnv = tryEnvUrl();
  if (fromEnv) {
    printBlock(fromEnv);
    process.exit(0);
  }

  const fromNgrok = await tryNgrok();
  if (fromNgrok) {
    printBlock(fromNgrok);
    process.exit(0);
  }

  await tryCloudflaredQuickTunnel();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
