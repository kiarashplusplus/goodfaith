/**
 * Where a member's notices go. Only the wallet currently linked to the membership may change it (dated signature as
 * for `start`); an empty `contact` removes it. The previous contact is told about the change.
 */
import type { NextRequest } from "next/server";
import { identity } from "@/lib/identity/env";
import { guarded, json, limited, provenWallet, readJson } from "@/lib/identity/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const slow = limited(request, 2);
  if (slow) return slow;
  const body = await readJson(request);
  const proven = await provenWallet(body);
  if ("error" in proven) return proven.error;
  const contact = typeof body!.contact === "string" ? body!.contact.trim().slice(0, 120) || undefined : undefined;
  return guarded(async () => json(await (await identity()).service.setContact(proven.wallet, contact)));
}
