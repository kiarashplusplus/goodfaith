/**
 * Operator-internal (IDENTITY_ADMIN_KEY), one recovery request:
 *   POST { feePayer }          the issuer-signed `propose_rebind`, built for the recovery key as fee payer (the CLI signs and sends it)
 *   POST { proposed: <sig> }   the proposal is on chain: the member is told about the veto window
 *   DELETE                     the request is turned down
 */
import type { NextRequest } from "next/server";
import { identity } from "@/lib/identity/env";
import { adminAuthorised, guarded, json, personIdOf, readJson, walletOf } from "@/lib/identity/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ personId: string }> };

export async function POST(request: NextRequest, { params }: Params): Promise<Response> {
  if (!adminAuthorised(request)) return json({ error: "Not authorised." }, 401);
  const personId = personIdOf((await params).personId);
  if (!personId) return json({ error: "personId must be 64 hex characters." }, 400);
  const body = await readJson(request);
  const feePayer = walletOf(body?.feePayer);
  const proposed = typeof body?.proposed === "string" ? body.proposed.slice(0, 120) : null;
  if (!feePayer && !proposed) return json({ error: "feePayer or proposed is required." }, 400);
  return guarded(async () => {
    const { service } = await identity();
    if (proposed) return json(await service.recoveryProposed(personId, proposed));
    return json(await service.prepareProposal(personId, feePayer!));
  });
}

export async function DELETE(request: NextRequest, { params }: Params): Promise<Response> {
  if (!adminAuthorised(request)) return json({ error: "Not authorised." }, 401);
  const personId = personIdOf((await params).personId);
  if (!personId) return json({ error: "personId must be 64 hex characters." }, 400);
  return guarded(async () => json({ rejected: await (await identity()).service.rejectRecovery(personId) }));
}
