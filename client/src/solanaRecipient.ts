import { PublicKey } from "@solana/web3.js";

/** Accept pasted base58 pubkey or `solana:<pubkey>?…` (Solana Pay style). */
export function parseRecipientFromScanOrPaste(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const solanaPay = t.match(/^solana:([1-9A-HJ-NP-Za-km-z]{32,48})(\?|$)/i);
  if (solanaPay) {
    try {
      return new PublicKey(solanaPay[1]).toBase58();
    } catch {
      /* fall through */
    }
  }
  const candidates = t.match(/[1-9A-HJ-NP-Za-km-z]{32,48}/g) ?? [];
  const byLen = [...new Set(candidates)].sort((a, b) => b.length - a.length);
  for (const c of byLen) {
    try {
      return new PublicKey(c).toBase58();
    } catch {
      /* try next */
    }
  }
  return null;
}

export function isValidSolanaRecipient(addr: string): boolean {
  try {
    new PublicKey(addr.trim());
    return true;
  } catch {
    return false;
  }
}
