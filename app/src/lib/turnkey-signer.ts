/**
 * A kit signer for a Turnkey embedded wallet. The key never leaves Turnkey: each transaction's message bytes, and
 * each proof message, go to Turnkey as a raw ed25519 payload and only the signature comes back. It is a partial
 * signer for transactions and messages, so lib/tx.ts and lib/identity-client.ts use it like any other wallet.
 */
import {
  getPublicKeyFromAddress,
  signatureBytes,
  verifySignature,
  type Address,
  type MessagePartialSigner,
  type SignatureBytes,
  type SignatureDictionary,
  type TransactionPartialSigner,
} from "@solana/kit";

/** Turnkey's raw-payload signing call, reduced to what an ed25519 key needs: hex in, `r` and `s` (hex) out. */
export type SignRaw = (req: {
  signWith: string;
  payload: string;
  encoding: "PAYLOAD_ENCODING_HEXADECIMAL";
  hashFunction: "HASH_FUNCTION_NOT_APPLICABLE";
}) => Promise<{ r: string; s: string }>;

const toHex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function fromHex(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(s)) throw new Error("Turnkey returned a signature that is not hex.");
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}

export type TurnkeySigner = TransactionPartialSigner & MessagePartialSigner;

export function createTurnkeySigner(walletAddress: Address, signRaw: SignRaw): TurnkeySigner {
  let key: Promise<CryptoKey> | undefined;
  const publicKey = () => (key ??= getPublicKeyFromAddress(walletAddress));

  // Signs one payload and refuses a signature that does not verify against the wallet's own key.
  async function sign(bytes: Parameters<typeof verifySignature>[2]): Promise<SignatureDictionary> {
    const { r, s } = await signRaw({
      signWith: walletAddress,
      payload: toHex(bytes),
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
    });
    const raw = fromHex(r + s);
    if (raw.length !== 64) throw new Error(`Turnkey returned a ${raw.length}-byte signature; ed25519 needs 64.`);
    const sig: SignatureBytes = signatureBytes(raw);
    if (!(await verifySignature(await publicKey(), sig, bytes))) throw new Error("Turnkey's signature does not match this wallet.");
    return Object.freeze({ [walletAddress]: sig });
  }

  return Object.freeze({
    address: walletAddress,
    signTransactions: (txs) => Promise.all(txs.map((tx) => sign(tx.messageBytes))),
    signMessages: (messages) => Promise.all(messages.map((m) => sign(m.content))),
  });
}

/** The part of Turnkey's HTTP client the signer uses (the kit's `httpClient`). */
type RawPayloadClient = {
  signRawPayload: (body: Parameters<SignRaw>[0]) => Promise<{ activity: { status: string }; r: string; s: string }>;
};

/** Turnkey's raw-payload call through the signed-in session; an activity that did not complete is an error. */
export function signRawWith(httpClient: RawPayloadClient): SignRaw {
  return async (req) => {
    const { activity, r, s } = await httpClient.signRawPayload(req);
    if (activity.status !== "ACTIVITY_STATUS_COMPLETED") throw new Error(`Turnkey did not sign (${activity.status}).`);
    return { r, s };
  };
}

/** The member's Solana address among their Turnkey wallets (the first embedded Solana account), or null. */
export function solanaAccountOf(
  wallets: readonly { source: string; accounts: readonly { address: string; addressFormat?: string }[] }[],
): string | null {
  for (const w of wallets) {
    if (w.source !== "embedded") continue;
    const a = w.accounts.find((x) => x.addressFormat === "ADDRESS_FORMAT_SOLANA");
    if (a) return a.address;
  }
  return null;
}
