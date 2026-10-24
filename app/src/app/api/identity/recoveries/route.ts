/** Operator-internal (IDENTITY_ADMIN_KEY): the queue of wallet-recovery requests, with the chain's view of each person. */
import type { NextRequest } from "next/server";
import { identity } from "@/lib/identity/env";
import { adminAuthorised, guarded, json } from "@/lib/identity/http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  if (!adminAuthorised(request)) return json({ error: "Not authorised." }, 401);
  return guarded(async () => json({ recoveries: await (await identity()).service.listRecoveries() }));
}
