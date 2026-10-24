/**
 * MoneyGram Ramps widget sessions. The browser asks here; this route asks MoneyGram with `MONEYGRAM_SK`, which never
 * leaves the server, and returns only the session token, id and widget URL (see `lib/moneygram.ts`).
 */
import type { NextRequest } from "next/server";
import { createRampsSession, sessionEnv } from "@/lib/moneygram";
import { TokenBucket, clientIp } from "@/lib/sponsor-proxy";

export const dynamic = "force-dynamic";

// Per server instance: a few widget opens in a burst, then one every ten seconds per client.
const bucket = new TokenBucket({
  capacity: Number(process.env.RAMPS_RATE_CAPACITY) || 5,
  refillPerSec: Number(process.env.RAMPS_RATE_REFILL_PER_SEC) || 0.1,
});

export async function POST(request: NextRequest): Promise<Response> {
  const limit = bucket.take(clientIp(request.headers), 1);
  if (!limit.ok)
    return Response.json({ error: "Too many requests." }, { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } });
  const r = await createRampsSession(sessionEnv());
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json(r.session, { headers: { "cache-control": "no-store" } });
}
