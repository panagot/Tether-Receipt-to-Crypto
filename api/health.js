/**
 * GET /api/health — explicit route (avoids dynamic api/[segment] bundling issues on Vercel).
 */
import { proxyToRtcApiSafe } from "./lib/proxyUpstream.js";

export default async function handler(req, res) {
  await proxyToRtcApiSafe(req, res);
}
