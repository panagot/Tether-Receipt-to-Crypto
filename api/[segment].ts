import type { IncomingMessage, ServerResponse } from "node:http";
import { proxyToRtcApiSafe, vercelRouteConfig } from "./lib/proxyUpstream";

export const config = vercelRouteConfig;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await proxyToRtcApiSafe(req, res);
}
