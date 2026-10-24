/**
 * Operator-internal: mirror a bar the chain set, by `personId` or `wallet`, with `until` (unix seconds as the chain
 * has it; absent means for good; a past time lifts the bar). The cranker calls this after every settlement, and the
 * admin CLI after `lift-bar`, with IDENTITY_ADMIN_KEY.
 */
import type { NextRequest } from "next/server";
import { identity } from "@/lib/identity/env";
import { adminAuthorised, guarded, json, personIdOf, readJson } from "@/lib/identity/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  if (!adminAuthorised(request)) return json({ error: "Not authorised." }, 401);
  const body = await readJson(request);
  const id = personIdOf(body?.personId);
  const wallet = typeof body?.wallet === "string" ? body.wallet : null;
  if (!id && !wallet) return json({ error: "personId (64 hex characters) or wallet is required." }, 400);
  const untilRaw = body?.until;
  const until = untilRaw === undefined || untilRaw === null ? undefined : Number(untilRaw);
  if (until !== undefined && !Number.isFinite(until)) return json({ error: "until must be unix seconds." }, 400);
  return guarded(async () => {
    const { service, store } = await identity();
    const p = id ?? (await store.getWallet(wallet!))?.personId;
    if (!p) return json({ banned: false, until: null, permanent: false, revoked: [], error: "No verified person for that wallet." }, 404);
    return json(await service.ban(p, until));
  });
}
