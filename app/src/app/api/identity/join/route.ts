/** Builds and issuer-signs the on-chain transaction for a verified wallet; the wallet signs and sends it. */
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
  return guarded(async () => json(await (await identity()).service.prepareJoin(wallet)));
}
