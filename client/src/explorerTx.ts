/** Solana Explorer deep link for a transaction signature. */
export function explorerTxUrl(signature: string, cluster: string): string {
  const sig = encodeURIComponent(signature.trim());
  if (cluster === "mainnet-beta" || cluster === "mainnet") {
    return `https://explorer.solana.com/tx/${sig}`;
  }
  if (cluster === "testnet") {
    return `https://explorer.solana.com/tx/${sig}?cluster=testnet`;
  }
  /* devnet, custom, or unknown — devnet explorer is the safest demo default */
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}
