/** A verified wallet re-checks to attach another document (renewal, second ID) to its person; proof of control as in start. */
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
  return guarded(async () => json(await (await identity()).service.startLink(wallet)));
}
