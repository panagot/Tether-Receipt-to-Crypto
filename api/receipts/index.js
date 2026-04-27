import { proxyToRtcApiSafe } from "../lib/proxyUpstream.js";

export default async function handler(req, res) {
  await proxyToRtcApiSafe(req, res);
}
