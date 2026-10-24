/**
 * Starts the hosted identity check for a wallet that proves control by signing a dated message. An optional `contact`
 * (an email, up to 120 characters) is where notices about the membership go; it is stored, never shown or sent on.
 */
import type { NextRequest } from "next/server";
import { identity } from "@/lib/identity/env";
import { guarded, json, limited, readJson, walletOf } from "@/lib/identity/http";
import { verifyProof } from "@/lib/identity/wallet-proof";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const slow = limited(request, 4);
  if (slow) return slow;
  const body = await readJson(request);
  const wallet = walletOf(body?.wallet);
  if (!body || !wallet || typeof body.message !== "string" || typeof body.signature !== "string")
    return json({ error: "wallet, message and signature are required." }, 400);
  if (!(await verifyProof(wallet, body.message, body.signature)))
    return json({ error: "The wallet signature is missing, stale or wrong." }, 401);
  const contact = typeof body.contact === "string" ? body.contact.trim().slice(0, 120) || undefined : undefined;
  return guarded(async () => json(await (await identity()).service.start(wallet, contact)));
}
