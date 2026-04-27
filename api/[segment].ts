import type { IncomingMessage, ServerResponse } from "node:http";
import { proxyToRtcApi, runtimeProxyConfig } from "./lib/proxyUpstream";

/** Hobby caps duration; long QVAC runs may need VITE_API_BASE_URL → tunnel directly or a paid tier. */
export const config = { ...runtimeProxyConfig, maxDuration: 60 } as const;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await proxyToRtcApi(req, res);
}
