/**
 * Optional absolute API origin for production static hosts (e.g. Vercel).
 * Build with: `VITE_API_BASE_URL=https://your-ngrok-host.ngrok.io npm run build`
 * Dev: leave unset — Vite proxies `/api` → http://127.0.0.1:3847
 */
export function getApiOrigin(): string {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? "";
  if (!raw) return "";
  return raw.replace(/\/$/, "");
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
