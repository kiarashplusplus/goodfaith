/**
 * Wallet recovery, by the new wallet itself (it signs a dated message, as for `start`): records the request for the
 * operator (202 with `requestedAt`; the operator's recovery CLI proposes it on chain), and after the on-chain delay
 * returns the finalize transaction. DELETE withdraws a request that has not been proposed yet.
 */
import type { NextRequest } from "next/server";
import { identity } from "@/lib/identity/env";
import { guarded, json, limited, provenWallet, readJson } from "@/lib/identity/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const slow = limited(request, 3);
  if (slow) return slow;
  const proven = await provenWallet(await readJson(request));
  if ("error" in proven) return proven.error;
  return guarded(async () => {
    const r = await (await identity()).service.prepareRebind(proven.wallet);
    return json(r, "kind" in r && r.kind === "review" ? 202 : 200);
  });
}

export async function DELETE(request: NextRequest): Promise<Response> {
  const slow = limited(request, 1);
  if (slow) return slow;
  const proven = await provenWallet(await readJson(request));
  if ("error" in proven) return proven.error;
  return guarded(async () => json({ cancelled: await (await identity()).service.cancelRecovery(proven.wallet) }));
}
