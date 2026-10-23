import { address, type Address } from "@solana/kit";
import { KORA_URL } from "./config";

/**
 * Minimal Kora JSON-RPC client (https://solana.com/docs/tools/kora/json-rpc-api).
 * We don't use the @solana/kora package: its Kit plugin targets older @solana/kit versions and breaks
 * the bundle with kit 8.5. `KORA_URL` is either Kora itself (development) or this app's own
 * `/api/sponsor` proxy, which holds the credentials and limits clients.
 */
export class KoraError extends Error {
  override readonly name = "KoraError";
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    readonly method?: string,
  ) {
    super(message);
  }
}

/** Codes produced by this client or the proxy (the JSON-RPC server-error range). Kora's own codes pass through. */
export const KORA_CODES = {
  UNREACHABLE: -32001,
  TIMEOUT: -32002,
  BAD_RESPONSE: -32003,
  NOT_CONFIGURED: -32004,
  RATE_LIMITED: -32005,
  AUTH: -32006,
} as const;

// Longer than the proxy's own limits so a proxy-side timeout arrives as a typed JSON-RPC error.
const TIMEOUT_MS: Record<string, number> = { getPayerSigner: 8_000, liveness: 8_000, signAndSendTransaction: 100_000 };

async function rpcCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(KORA_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS[method] ?? 30_000),
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    throw new KoraError(
      timedOut ? KORA_CODES.TIMEOUT : KORA_CODES.UNREACHABLE,
      timedOut ? "Fee sponsor timed out." : "Fee sponsor is unreachable.",
      undefined,
      method,
    );
  }
  if (res.status === 401 || res.status === 403) throw new KoraError(KORA_CODES.AUTH, "Fee sponsor refused the request.", undefined, method);
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
    throw new KoraError(KORA_CODES.BAD_RESPONSE, `Fee sponsor returned HTTP ${res.status}.`, undefined, method);
  }
  const json = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (json.error) throw new KoraError(json.error.code, json.error.message, json.error.data, method);
  if (!res.ok || json.result === undefined)
    throw new KoraError(KORA_CODES.BAD_RESPONSE, `Fee sponsor returned HTTP ${res.status} without a result.`, undefined, method);
  return json.result;
}

export const koraEnabled = KORA_URL !== "";

export const kora = koraEnabled
  ? {
      liveness: () => rpcCall<unknown>("liveness"),
      getPayerSigner: () => rpcCall<{ signer_address: string; payment_address: string }>("getPayerSigner"),
      /**
       * transaction: base64 wire transaction signed by the user. Kora adds the fee-payer signature and sends it,
       * replying only once the transaction is confirmed. `signer_key` pins the signer the message was built for.
       */
      signAndSendTransaction: (p: { transaction: string; signer_key?: string }) =>
        rpcCall<{ signature: string; signed_transaction: string; signer_pubkey: string }>("signAndSendTransaction", p),
    }
  : null;

const PAYER_TTL_MS = 60_000;
const FAILURE_BACKOFF_MS = 15_000;
let cache: { payer: Address | null; at: number } | null = null;
let inflight: Promise<Address | null> | null = null;

/**
 * Kora's fee-payer address, or null if sponsorship is unavailable (users then pay their own fees and rent).
 * Cached for a minute; after a failure, not retried for 15 s. Concurrent callers share one request.
 */
export function getKoraPayer(): Promise<Address | null> {
  if (!kora) return Promise.resolve(null);
  const now = Date.now();
  if (cache && now - cache.at < (cache.payer ? PAYER_TTL_MS : FAILURE_BACKOFF_MS)) return Promise.resolve(cache.payer);
  if (!inflight) {
    inflight = kora
      .getPayerSigner()
      .then((r) => address(r.signer_address))
      .catch(() => null)
      .then((payer) => {
        cache = { payer, at: Date.now() };
        inflight = null;
        return payer;
      });
  }
  return inflight;
}

/** Synchronous view of the last sponsor check, for UI that must not await. */
export function sponsorState(): { enabled: boolean; payer: Address | null; checkedAt: number | null } {
  return { enabled: koraEnabled, payer: cache?.payer ?? null, checkedAt: cache?.at ?? null };
}

/** Test hook: forget the cached payer. */
export function resetSponsorCache(): void {
  cache = null;
  inflight = null;
}
