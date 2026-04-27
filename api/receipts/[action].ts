import type { IncomingMessage, ServerResponse } from "node:http";
import { proxyToRtcApi, runtimeProxyConfig } from "../lib/proxyUpstream";

export const config = { ...runtimeProxyConfig, maxDuration: 60 } as const;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await proxyToRtcApi(req, res);
}
