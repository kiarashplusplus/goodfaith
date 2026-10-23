import { address, type Address } from "@solana/kit";
import { KORA_URL } from "./config";

/**
 * Minimal Kora JSON-RPC client (https://solana.com/docs/tools/kora/json-rpc-api).
 * We don't use the @solana/kora package: its Kit plugin imports `createEmptyClient`,
 * which @solana/kit 8.5 no longer exports, so it breaks the bundle.
 * The Kora server must allow this site's origin (CORS) and be configured to sponsor
 * the Good Faith program, the token program and the associated token program.
 */
async function rpcCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(KORA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (json.error) throw new Error(`Fee sponsor error: ${json.error.message}`);
  if (json.result === undefined) throw new Error("Fee sponsor returned no result.");
  return json.result;
}

export const koraEnabled = KORA_URL !== "";

export const kora = koraEnabled
  ? {
      getPayerSigner: () => rpcCall<{ signer_address: string; payment_address: string }>("getPayerSigner"),
      /** transaction: base64 wire transaction signed by the user. Kora adds the fee-payer signature and sends it. */
      signAndSendTransaction: (p: { transaction: string }) =>
        rpcCall<{ signature: string; signed_transaction: string; signer_pubkey: string }>("signAndSendTransaction", p),
    }
  : null;

let payerPromise: Promise<Address | null> | null = null;

/** Kora's fee-payer address, or null if sponsorship is unavailable (users then pay their own fees). */
export function getKoraPayer(): Promise<Address | null> {
  if (!kora) return Promise.resolve(null);
  if (!payerPromise) {
    payerPromise = kora
      .getPayerSigner()
      .then((r) => address(r.signer_address))
      .catch(() => {
        payerPromise = null; // allow retry later
        return null;
      });
  }
  return payerPromise;
}
