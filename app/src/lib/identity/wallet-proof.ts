/**
 * Proof that whoever starts an identity check controls the wallet: the wallet signs a short dated message.
 * Without it, a stranger could attach their identity to someone else's wallet address.
 */
import { getBase64Encoder, getPublicKeyFromAddress, verifySignature, type Address, type SignatureBytes } from "@solana/kit";

export const PROOF_MAX_AGE_SEC = 300;

export function proofMessage(wallet: Address, unixSec: number): string {
  return `Good Faith identity check\nWallet: ${wallet}\nTime: ${unixSec}`;
}

/** Parses the message, checks its wallet and freshness, and verifies the ed25519 signature (base64). */
export async function verifyProof(
  wallet: Address,
  message: string,
  signatureB64: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const m = /^Good Faith identity check\nWallet: ([1-9A-HJ-NP-Za-km-z]{32,44})\nTime: (\d{1,12})$/.exec(message);
  if (!m || m[1] !== wallet) return false;
  if (Math.abs(nowSec - Number(m[2])) > PROOF_MAX_AGE_SEC) return false;
  let sig: Uint8Array;
  try {
    sig = new Uint8Array(getBase64Encoder().encode(signatureB64));
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  try {
    const key = await getPublicKeyFromAddress(wallet);
    return await verifySignature(key, sig as SignatureBytes, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}
