/**
 * Starts the hosted identity check for a wallet that proves control by signing a dated message. `contact` (required:
 * an email, up to 120 characters; the app sends the member's Turnkey sign-in email) is where notices about the
 * membership go; it is stored and sent only to the notice
 * relay with each notice (`lib/identity/notify.ts`), never shown or published.
 */
import type { NextRequest } from "next/server";
import { identity } from "@/lib/identity/env";
import { emailOf, guarded, json, limited, provenWallet, readJson } from "@/lib/identity/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const slow = limited(request, 4);
  if (slow) return slow;
  const body = await readJson(request);
  const proven = await provenWallet(body);
  if ("error" in proven) return proven.error;
  const contact = emailOf(body!.contact);
  if (!contact) return json({ error: "An email for notices about your membership is required." }, 400);
  return guarded(async () => json(await (await identity()).service.start(proven.wallet, contact)));
}
