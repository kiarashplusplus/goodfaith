/**
 * Operator-internal (IDENTITY_ADMIN_KEY): the cranker's reconciliation pass. `barred` lists every person the chain
 * bars now with `until` (unix seconds); stored bars the chain no longer has are lifted, recovery requests the chain
 * finalised or vetoed are closed, and failed request notices are sent again.
 */
import type { NextRequest } from "next/server";
import { identity } from "@/lib/identity/env";
import { adminAuthorised, guarded, json, personIdOf, readJson } from "@/lib/identity/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  if (!adminAuthorised(request)) return json({ error: "Not authorised." }, 401);
  const body = await readJson(request, 512 * 1024);
  const raw = Array.isArray(body?.barred) ? (body!.barred as unknown[]) : null;
  if (!raw) return json({ error: "barred must be an array of { personId, until }." }, 400);
  const barred: { personId: string; until: number }[] = [];
  for (const item of raw) {
    const o = item as { personId?: unknown; until?: unknown };
    const id = personIdOf(o.personId);
    const until = Number(o.until);
    if (!id || !Number.isFinite(until))
      return json({ error: "each entry needs personId (64 hex characters) and until (unix seconds)." }, 400);
    barred.push({ personId: id, until });
  }
  return guarded(async () => json(await (await identity()).service.reconcile(barred)));
}
