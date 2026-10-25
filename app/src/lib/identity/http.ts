/** Shared plumbing for the identity routes: JSON replies, error mapping, a per-client limiter, the operator's key. */
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { address, type Address } from "@solana/kit";
import { TokenBucket, clientIp } from "../sponsor-proxy";
import { IdentityError } from "./service";
import { verifyProof, type ProofPurpose } from "./wallet-proof";

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

/**
 * The wallet named in the body, once its dated signature checks out (`message`, `signature`); otherwise the error
 * reply. Every route that acts for a wallet (start, link, rebind, renew, contact) goes through this with the
 * "identity" purpose; reading the details of a check (status) uses "status", which those routes refuse.
 */
export async function provenWallet(
  body: Record<string, unknown> | null,
  purpose: ProofPurpose = "identity",
): Promise<{ wallet: Address } | { error: Response }> {
  const wallet = walletOf(body?.wallet);
  if (!body || !wallet || typeof body.message !== "string" || typeof body.signature !== "string")
    return { error: json({ error: "wallet, message and signature are required." }, 400) };
  if (!(await verifyProof(wallet, body.message, body.signature, undefined, purpose)))
    return { error: json({ error: "The wallet signature is missing, stale or wrong." }, 401) };
  return { wallet };
}

/** The operator's shared secret (IDENTITY_ADMIN_KEY) in `x-identity-admin-key`. */
export function adminAuthorised(request: NextRequest): boolean {
  const key = process.env.IDENTITY_ADMIN_KEY?.trim() ?? "";
  const given = request.headers.get("x-identity-admin-key") ?? "";
  if (!key || given.length !== key.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(key));
}

/** A 64-hex-character person id, or null. */
export function personIdOf(v: unknown): string | null {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : null;
}

/** An email for membership notices: required since members sign in with Turnkey, at most 120 characters. */
export function emailOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim();
  return e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
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
