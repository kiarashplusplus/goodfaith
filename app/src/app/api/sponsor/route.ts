/**
 * Fee-sponsor proxy. The browser talks to this route; this route talks to Kora with the server-side
 * credentials (`KORA_URL`, `KORA_API_KEY`, `KORA_HMAC_SECRET`). Kora 2.0.5 accepts any origin and only
 * rate-limits globally, so this is where origin control, auth and per-client limits live.
 * Only three methods are forwarded; everything else is refused before it reaches Kora.
 */
import type { NextRequest } from "next/server";
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
  const { id, method, body } = parsed.req;

  const limit = bucket.take(clientIp(request.headers), ALLOWED_METHODS[method].cost);
  if (!limit.ok) {
    return reply(jsonRpcError(id, PROXY_ERROR.RATE_LIMITED, "Too many requests."), 429, { "retry-after": String(limit.retryAfterSec) });
  }

  const cfg = env();
  if (!cfg.url) return reply(jsonRpcError(id, PROXY_ERROR.NOT_CONFIGURED, "Fee sponsor is not configured on the server."));

  return forward(cfg, id, body, ALLOWED_METHODS[method].timeoutMs);
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
