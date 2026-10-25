/**
 * Where a wallet stands: identity check, pass, on-chain membership, and what to do next.
 * GET (anyone, for polling) leaves out the check's reason and its one-time link; POST with the wallet's dated
 * "status" signature returns them too (`IdentityService.status`).
 */
import type { NextRequest } from "next/server";
import { identity } from "@/lib/identity/env";
import { guarded, json, limited, provenWallet, readJson, walletOf } from "@/lib/identity/http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const slow = limited(request, 1);
  if (slow) return slow;
  const wallet = walletOf(request.nextUrl.searchParams.get("wallet"));
  if (!wallet) return json({ error: "wallet is required." }, 400);
  return guarded(async () => json(await (await identity()).service.status(wallet)));
}

export async function POST(request: NextRequest): Promise<Response> {
  const slow = limited(request, 1);
  if (slow) return slow;
  const proven = await provenWallet(await readJson(request), "status");
  if ("error" in proven) return proven.error;
  return guarded(async () =>
    json(await (await identity()).service.status(proven.wallet, { details: true }), 200, { "cache-control": "no-store" }),
  );
}
