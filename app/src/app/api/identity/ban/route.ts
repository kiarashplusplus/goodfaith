/** Operator-internal: bar a person after a default. The cranker calls this with IDENTITY_ADMIN_KEY. */
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { identity } from "@/lib/identity/env";
import { guarded, json, readJson } from "@/lib/identity/http";

export const dynamic = "force-dynamic";

function authorised(request: NextRequest): boolean {
  const key = process.env.IDENTITY_ADMIN_KEY?.trim() ?? "";
  const given = request.headers.get("x-identity-admin-key") ?? "";
  if (!key || given.length !== key.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(key));
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!authorised(request)) return json({ error: "Not authorised." }, 401);
  const body = await readJson(request);
  const hash = body?.personHash;
  const wallet = typeof body?.wallet === "string" ? body.wallet : null;
  if ((typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) && !wallet)
    return json({ error: "personHash (64 hex characters) or wallet is required." }, 400);
  return guarded(async () => {
    const { service, store } = await identity();
    const h = typeof hash === "string" && hash ? hash : store.getWallet(wallet!)?.personHash;
    if (!h) return json({ banned: false, revoked: [], error: "No verified person for that wallet." }, 404);
    return json(await service.ban(h));
  });
}
