import { proxyToRtcApiSafe, vercelRouteConfig } from "./lib/proxyUpstream.js";

export const config = vercelRouteConfig;

export default async function handler(req, res) {
  await proxyToRtcApiSafe(req, res);
}
