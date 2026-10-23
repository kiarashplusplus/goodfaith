/** Shared plumbing for the identity routes: JSON replies, error mapping, a per-client limiter. */
import type { NextRequest } from "next/server";
import { address, type Address } from "@solana/kit";
import { TokenBucket, clientIp } from "../sponsor-proxy";
import { IdentityError } from "./service";

const bucket = new TokenBucket({
  capacity: Number(process.env.IDENTITY_RATE_CAPACITY) || 20,
  refillPerSec: Number(process.env.IDENTITY_RATE_REFILL_PER_SEC) || 0.2,
});

export const json = (body: unknown, status = 200, headers?: Record<string, string>) => Response.json(body, { status, headers });

export function limited(request: NextRequest, cost = 1): Response | null {
  const r = bucket.take(clientIp(request.headers), cost);
  return r.ok ? null : json({ error: "Too many requests. Wait a moment and try again." }, 429, { "retry-after": String(r.retryAfterSec) });
}

export async function readJson(request: NextRequest, maxBytes = 8 * 1024): Promise<Record<string, unknown> | null> {
  const raw = await request.text();
  if (raw.length > maxBytes) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function walletOf(v: unknown): Address | null {
  if (typeof v !== "string") return null;
  try {
    return address(v);
  } catch {
    return null;
  }
}

/** Runs a handler and turns thrown errors into JSON replies without leaking stack traces. */
export async function guarded(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof IdentityError) return json({ error: e.message }, e.status);
    const message = e instanceof Error ? e.message : String(e);
    console.error("[identity]", message);
    return json(
      {
        error: /not set|must be|required|IDENTITY_|PERSONA_/.test(message)
          ? `Identity service is not configured: ${message}`
          : "Identity service error.",
      },
      500,
    );
  }
}
