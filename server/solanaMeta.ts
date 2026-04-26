/** Infer explorer cluster label from RPC URL; override with SOLANA_CLUSTER when non-standard hosts. */
export function inferSolanaCluster(rpcUrl: string): string {
  const u = rpcUrl.toLowerCase();
  if (u.includes("mainnet-beta") || u.includes("api.mainnet")) return "mainnet-beta";
  if (u.includes("devnet")) return "devnet";
  if (u.includes("testnet")) return "testnet";
  return "custom";
}

export function displayClusterName(cluster: string): string {
  if (cluster === "mainnet-beta") return "Mainnet";
  if (cluster === "devnet") return "Devnet";
  if (cluster === "testnet") return "Testnet";
  return "Custom RPC";
}
