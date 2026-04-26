import WalletManagerSolana from "@tetherto/wdk-wallet-solana";

export async function sendUsdt(params: {
  recipient: string;
  amountBaseUnits: number;
  memo?: string;
}): Promise<{ signature: string }> {
  const seed = process.env.WALLET_SEED?.trim();
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const mint = process.env.USDT_MINT?.trim();
  if (!seed) {
    throw new Error("WALLET_SEED is not set (use a throwaway devnet seed only).");
  }
  if (!mint) {
    throw new Error("USDT_MINT is not set for this cluster.");
  }

  const manager = new WalletManagerSolana(seed, {
    rpcUrl,
    commitment: "confirmed",
  });
  const account = await manager.getAccount(0);
  const result = await account.transfer({
    token: mint,
    recipient: params.recipient,
    amount: params.amountBaseUnits,
  });
  return { signature: result.hash };
}
