/**
 * API origin for static hosts (e.g. Vercel) where `/api` is not on the same host.
 *
 * Resolution order:
 * 1. `VITE_API_BASE_URL` at build time (preferred for production).
 * 2. One-time `?rtc_api=https://your-tunnel.example` on open — stored in sessionStorage for this tab.
 * 3. Dev: leave unset — Vite proxies `/api` → http://127.0.0.1:3847
 */

const STORAGE_KEY = "rtc_api_origin";
const QUERY_KEY = "rtc_api";

let syncedQuery = false;

function stripTrailingSlash(s: string): string {
  return s.replace(/\/$/, "");
}

/** Accepts full URL or host; returns `https://host` origin only. */
export function normalizeApiOrigin(input: string): string {
  let s = input.trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

function syncRtcApiQueryOnce(): void {
  if (syncedQuery || typeof window === "undefined") return;
  syncedQuery = true;
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get(QUERY_KEY)?.trim();
    if (!raw) return;
    const origin = normalizeApiOrigin(raw);
    if (!origin) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, origin);
    } catch {
      /* quota / private mode */
    }
    params.delete(QUERY_KEY);
    const next = params.toString();
    const path = window.location.pathname + (next ? `?${next}` : "") + window.location.hash;
    window.history.replaceState({}, "", path);
  } catch {
    /* ignore */
  }
}

export function getApiOrigin(): string {
  syncRtcApiQueryOnce();

  const fromEnv = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? "";
  if (fromEnv) return stripTrailingSlash(fromEnv);

  try {
    const stored = sessionStorage.getItem(STORAGE_KEY)?.trim() ?? "";
    if (stored) return stripTrailingSlash(normalizeApiOrigin(stored) || stored);
  } catch {
    /* private mode */
  }

  return "";
}

/** Path must start with `/api/...`. Returns absolute URL or same-origin path. */
export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  const origin = getApiOrigin();
  if (!origin) return p;
  return `${origin}${p}`;
}

export function isStaticBuildWithoutRemoteApi(): boolean {
  return import.meta.env.PROD && !getApiOrigin();
}
