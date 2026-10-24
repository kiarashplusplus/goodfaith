/**
 * Wallet recovery: records the request for the operator (202 with `requestedAt`; the operator's recovery CLI
 * proposes it on chain), and after the on-chain delay returns the finalize transaction. DELETE withdraws a request
 * that has not been proposed yet.
 */
import type { NextRequest } from "next/server";
import { identity } from "@/lib/identity/env";
import { guarded, json, limited, readJson, walletOf } from "@/lib/identity/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const slow = limited(request, 3);
  if (slow) return slow;
  const body = await readJson(request);
  const wallet = walletOf(body?.wallet);
  if (!wallet) return json({ error: "wallet is required." }, 400);
  return guarded(async () => {
    const r = await (await identity()).service.prepareRebind(wallet);
    return json(r, "kind" in r && r.kind === "review" ? 202 : 200);
  });
}

export async function DELETE(request: NextRequest): Promise<Response> {
  const slow = limited(request, 1);
  if (slow) return slow;
  const body = await readJson(request);
  const wallet = walletOf(body?.wallet);
  if (!wallet) return json({ error: "wallet is required." }, 400);
  return guarded(async () => json({ cancelled: await (await identity()).service.cancelRecovery(wallet) }));
}
