/** Provider webhooks. The raw body is verified against the provider's signature before anything is parsed. */
import type { NextRequest } from "next/server";
import { identity } from "@/lib/identity/env";
import { guarded, json } from "@/lib/identity/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const raw = await request.text();
  if (raw.length > 256 * 1024) return json({ error: "Payload too large." }, 413);
  return guarded(async () => {
    const result = await (await identity()).service.handleWebhook(request.headers, raw);
    if (result === "bad_signature") return json({ error: "Bad signature." }, 401);
    return json({ result });
  });
}
