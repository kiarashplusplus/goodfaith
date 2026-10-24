/** Renews a member's pass for another term, without a new paid check; the wallet proves control as for `start`. */
import type { NextRequest } from "next/server";
import { identity } from "@/lib/identity/env";
import { guarded, json, limited, provenWallet, readJson } from "@/lib/identity/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const slow = limited(request, 3);
  if (slow) return slow;
  const proven = await provenWallet(await readJson(request));
  if ("error" in proven) return proven.error;
  return guarded(async () => json(await (await identity()).service.renew(proven.wallet)));
}
