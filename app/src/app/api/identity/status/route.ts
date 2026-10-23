/** Where a wallet stands: identity check, pass, on-chain membership, and what to do next. */
import type { NextRequest } from "next/server";
import { identity } from "@/lib/identity/env";
import { guarded, json, limited, walletOf } from "@/lib/identity/http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const slow = limited(request, 1);
  if (slow) return slow;
  const wallet = walletOf(request.nextUrl.searchParams.get("wallet"));
  if (!wallet) return json({ error: "wallet is required." }, 400);
  return guarded(async () => json(await (await identity()).service.status(wallet)));
}
