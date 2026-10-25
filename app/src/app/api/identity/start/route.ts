/**
 * Starts the hosted identity check for a wallet that proves control by signing a dated message. An optional `contact`
 * (an email, up to 120 characters) is where notices about the membership go; it is stored and sent only to the notice
 * relay with each notice (`lib/identity/notify.ts`), never shown or published.
 */
import type { NextRequest } from "next/server";
import { identity } from "@/lib/identity/env";
import { guarded, json, limited, provenWallet, readJson } from "@/lib/identity/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const slow = limited(request, 4);
  if (slow) return slow;
  const body = await readJson(request);
  const proven = await provenWallet(body);
  if ("error" in proven) return proven.error;
  const contact = typeof body!.contact === "string" ? body!.contact.trim().slice(0, 120) || undefined : undefined;
  return guarded(async () => json(await (await identity()).service.start(proven.wallet, contact)));
}
