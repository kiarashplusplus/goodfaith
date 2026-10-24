/**
 * Fee-sponsor proxy. The browser talks to this route; this route talks to Kora with the server-side
 * credentials (`KORA_URL`, `KORA_API_KEY`, `KORA_HMAC_SECRET`). Kora 2.0.5 accepts any origin and only
 * rate-limits globally, so this is where origin control, auth, per-client limits and the sponsorship policy live:
 * only three methods are forwarded, a transaction is decoded and checked against `sponsor-policy.ts` first, and
 * each wallet has a daily transaction and a lifetime token-account allowance.
 */
import type { NextRequest } from "next/server";
import { createSolanaRpc, type Address } from "@solana/kit";
import { POOL_MINT, PROGRAM_ID, RPC_URL } from "@/lib/config";
import { openStore } from "@/lib/identity/db";
import { serverKoraPayer } from "@/lib/kora-server";
import { budgetFromEnv, inspectTransaction, limitsFromEnv, needsMembership, utcDay, type CreatedAta } from "@/lib/sponsor-policy";
import { fetchMember, findPoolPda } from "@/lib/program";
import {
  ALLOWED_METHODS,
  MAX_BODY_BYTES,
  PROXY_ERROR,
  TokenBucket,
  authHeaders,
  clientIp,
  jsonRpcError,
  parseRpcRequest,
  type RpcId,
} from "@/lib/sponsor-proxy";

// Reads request headers and must never be cached. maxDuration is a hosting-platform hint; the real bound
// is the AbortSignal on the upstream fetch (a sign-and-send waits for on-chain confirmation).
export const dynamic = "force-dynamic";
export const maxDuration = 100;

// Per server instance; tune with SPONSOR_RATE_CAPACITY / SPONSOR_RATE_REFILL_PER_SEC. Defaults allow ten sponsored
// sends in a burst (cost 3 each), then one every three seconds. Put a shared limiter in front for a fleet of instances.
const bucket = new TokenBucket({
  capacity: Number(process.env.SPONSOR_RATE_CAPACITY) || 30,
  refillPerSec: Number(process.env.SPONSOR_RATE_REFILL_PER_SEC) || 1,
});

const reply = (body: unknown, status = 200, headers?: Record<string, string>) => Response.json(body, { status, headers });

function env() {
  return {
    url: process.env.KORA_URL?.trim() ?? "",
    apiKey: process.env.KORA_API_KEY?.trim() || undefined,
    hmacSecret: process.env.KORA_HMAC_SECRET?.trim() || undefined,
  };
}

export async function POST(request: NextRequest): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return reply(jsonRpcError(null, PROXY_ERROR.BODY_TOO_LARGE, "Request too large."), 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return reply(jsonRpcError(null, PROXY_ERROR.BODY_TOO_LARGE, "Request too large."), 413);

  const parsed = parseRpcRequest(raw);
  if (!parsed.ok) return reply(jsonRpcError(parsed.id, parsed.code, parsed.message), 400);
  const { id, method, params, body } = parsed.req;

  const limit = bucket.take(clientIp(request.headers), ALLOWED_METHODS[method].cost);
  if (!limit.ok) {
    return reply(jsonRpcError(id, PROXY_ERROR.RATE_LIMITED, "Too many requests."), 429, { "retry-after": String(limit.retryAfterSec) });
  }

  const cfg = env();
  if (!cfg.url) return reply(jsonRpcError(id, PROXY_ERROR.NOT_CONFIGURED, "Fee sponsor is not configured on the server."));

  if (method !== "signAndSendTransaction") return forward(cfg, id, body, ALLOWED_METHODS[method].timeoutMs);

  // The sponsorship policy: who pays, what the transaction does, and this wallet's allowance.
  const payer = await serverKoraPayer();
  if (!payer) return reply(jsonRpcError(id, PROXY_ERROR.UPSTREAM_UNREACHABLE, "Fee sponsor is unreachable."));
  const inspection = inspectTransaction(String(params.transaction), { payer, programId: PROGRAM_ID, mint: POOL_MINT });
  if (!inspection.ok) return reply(jsonRpcError(id, PROXY_ERROR.TRANSACTION_REFUSED, inspection.reason));
  // Rent for a token account on its own is for members: a stranger does not get accounts created at the fund's expense.
  if (needsMembership(inspection) && !(await isMember(inspection.wallet)))
    return reply(jsonRpcError(id, PROXY_ERROR.TRANSACTION_REFUSED, "Token accounts are only sponsored for members of the fund."));
  const store = openStore();
  const newAtas = await missing(inspection.atas);
  const day = utcDay(Date.now());
  // Reserve first, forward second: the counters are conditional increments in the store, so two requests in flight
  // cannot both pass the last slot. A definite refusal gives the slot back; a timeout keeps it (the transaction may
  // have landed), which errs on the side of the budget.
  const newWallet = (await store.getSponsorUsage(inspection.wallet)) === null;
  const usage = await store.reserveSponsorUsage(inspection.wallet, day, newAtas.length, limitsFromEnv(process.env));
  if (!usage)
    return reply(jsonRpcError(id, PROXY_ERROR.WALLET_CAP, "This wallet has used today's sponsored transactions or its token accounts."));
  const budgeted = await store.reserveSponsorBudget(day, newWallet, budgetFromEnv(process.env));
  if (!budgeted) {
    await store.releaseSponsorUsage(inspection.wallet, day, newAtas.length);
    return reply(jsonRpcError(id, PROXY_ERROR.BUDGET_EXHAUSTED, "The fee sponsor has used today's budget."));
  }
  const res = await forward(cfg, id, body, ALLOWED_METHODS[method].timeoutMs);
  const outcome = await classify(res.clone());
  if (outcome === "refused") {
    await store.releaseSponsorUsage(inspection.wallet, day, newAtas.length);
    await store.releaseSponsorBudget(day, newWallet);
  }
  return res;
}

async function isMember(wallet: Address): Promise<boolean> {
  try {
    const rpc = createSolanaRpc(RPC_URL);
    const [pool] = await findPoolPda(POOL_MINT);
    const m = await fetchMember(rpc, pool, wallet);
    return !!m && !m.retired;
  } catch {
    return false;
  }
}

/** What happened upstream: a result, a definite refusal (an error reply), or unknown (timeout, bad response). */
async function classify(res: Response): Promise<"sent" | "refused" | "unknown"> {
  try {
    const j = (await res.json()) as { result?: unknown; error?: { code?: number } };
    if (j.result !== undefined && j.error === undefined) return "sent";
    if (j.error && j.error.code !== PROXY_ERROR.UPSTREAM_TIMEOUT && j.error.code !== PROXY_ERROR.UPSTREAM_UNREACHABLE) return "refused";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** The token accounts in the transaction that do not exist yet (the ones whose rent the sponsor would pay). */
async function missing(atas: CreatedAta[]): Promise<Address[]> {
  if (!atas.length) return [];
  const rpc = createSolanaRpc(RPC_URL);
  const { value } = await rpc
    .getMultipleAccounts(
      atas.map((a) => a.ata),
      { encoding: "base64", commitment: "confirmed" },
    )
    .send();
  return atas.filter((_, i) => value[i] === null).map((a) => a.ata);
}

/** Liveness, auth-exempt upstream. */
export async function GET(): Promise<Response> {
  const cfg = env();
  if (!cfg.url) return reply({ ok: false, reason: "not configured" }, 503);
  try {
    const res = await fetch(new URL("/liveness", cfg.url), { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    return reply({ ok: res.ok }, res.ok ? 200 : 503);
  } catch {
    return reply({ ok: false, reason: "unreachable" }, 503);
  }
}

async function forward(cfg: ReturnType<typeof env>, id: RpcId, body: string, timeoutMs: number): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders({ apiKey: cfg.apiKey, hmacSecret: cfg.hmacSecret }, body) },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    return reply(
      jsonRpcError(
        id,
        timedOut ? PROXY_ERROR.UPSTREAM_TIMEOUT : PROXY_ERROR.UPSTREAM_UNREACHABLE,
        timedOut ? "Fee sponsor timed out." : "Fee sponsor is unreachable.",
      ),
    );
  }
  if (upstream.status === 401 || upstream.status === 403) {
    return reply(jsonRpcError(id, PROXY_ERROR.UPSTREAM_AUTH, "Fee sponsor refused the server's credentials."));
  }
  const text = await upstream.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return reply(
      jsonRpcError(id, PROXY_ERROR.UPSTREAM_BAD_RESPONSE, "Fee sponsor returned an unexpected response.", { status: upstream.status }),
    );
  }
  if (!upstream.ok && !(typeof json === "object" && json !== null && "error" in json)) {
    return reply(
      jsonRpcError(id, PROXY_ERROR.UPSTREAM_BAD_RESPONSE, `Fee sponsor returned HTTP ${upstream.status}.`, { status: upstream.status }),
    );
  }
  // Upstream JSON-RPC results and errors pass through unchanged.
  return reply(json);
}
