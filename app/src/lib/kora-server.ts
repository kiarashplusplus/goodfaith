/**
 * Server-side view of the fee sponsor: the identity routes ask Kora for its payer address directly
 * (`KORA_URL` with the server credentials), never through the browser-facing proxy.
 */
import { address, type Address } from "@solana/kit";
import { authHeaders } from "./sponsor-proxy";

let cache: { payer: Address | null; at: number } | null = null;

export async function serverKoraPayer(now = Date.now()): Promise<Address | null> {
  const url = process.env.KORA_URL?.trim();
  if (!url) return null;
  if (cache && now - cache.at < (cache.payer ? 60_000 : 15_000)) return cache.payer;
  let payer: Address | null = null;
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getPayerSigner", params: {} });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(
          { apiKey: process.env.KORA_API_KEY?.trim() || undefined, hmacSecret: process.env.KORA_HMAC_SECRET?.trim() || undefined },
          body,
        ),
      },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    const json = (await res.json()) as { result?: { signer_address?: string } };
    if (res.ok && json.result?.signer_address) payer = address(json.result.signer_address);
  } catch {
    payer = null;
  }
  cache = { payer, at: now };
  return payer;
}

/** Test hook. */
export function resetServerKoraCache(): void {
  cache = null;
}
