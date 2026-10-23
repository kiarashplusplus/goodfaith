/**
 * The "hosted flow" of the mock provider: a page with Approve and Decline buttons, and the endpoint they call,
 * which turns the decision into a signed webhook event. Only exists when IDENTITY_PROVIDER=mock.
 */
import type { NextRequest } from "next/server";
import { identity } from "@/lib/identity/env";
import { MockProvider, MOCK_FIELDS_TX } from "@/lib/identity/mock";
import { guarded, json, readJson } from "@/lib/identity/http";
import type { InquiryOutcome, VerifiedFields } from "@/lib/identity/provider";

export const dynamic = "force-dynamic";

const page = (inquiry: string) => `<!doctype html><meta charset="utf-8"><title>Mock identity check</title>
<body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem">
<h1>Mock identity check</h1><p>Inquiry <code>${inquiry}</code>. This stands in for the provider's hosted flow on test networks.</p>
<p><button id="a">Approve (Texas, adult)</button> <button id="d">Decline</button> <button id="o">Approve (out of state)</button></p><pre id="r"></pre>
<script>
const send=(outcome,fields)=>fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({inquiryId:${JSON.stringify(inquiry)},outcome,fields})}).then(r=>r.json()).then(j=>{document.getElementById('r').textContent=JSON.stringify(j,null,1)});
a.onclick=()=>send('approved');d.onclick=()=>send('declined');o.onclick=()=>send('approved',{idNumber:'99887766',issuingState:'CA',birthdate:'1980-01-01'});
</script>`;

async function mock(): Promise<{ provider: MockProvider; service: Awaited<ReturnType<typeof identity>>["service"] } | null> {
  const b = await identity();
  return b.provider instanceof MockProvider ? { provider: b.provider, service: b.service } : null;
}

export async function GET(request: NextRequest): Promise<Response> {
  return guarded(async () => {
    if (!(await mock())) return json({ error: "Not found." }, 404);
    const inquiry = request.nextUrl.searchParams.get("inquiry") ?? "";
    if (!/^mock-\d+$/.test(inquiry)) return json({ error: "inquiry is required." }, 400);
    return new Response(page(inquiry), { headers: { "content-type": "text/html; charset=utf-8" } });
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  return guarded(async () => {
    const m = await mock();
    if (!m) return json({ error: "Not found." }, 404);
    const body = await readJson(request);
    const inquiryId = body?.inquiryId;
    const outcome = body?.outcome as InquiryOutcome | undefined;
    if (typeof inquiryId !== "string" || !outcome || !["approved", "declined", "needs_review"].includes(outcome))
      return json({ error: "inquiryId and outcome are required." }, 400);
    const f = body?.fields as Partial<VerifiedFields> | undefined;
    const fields: VerifiedFields =
      f && typeof f.idNumber === "string" && typeof f.issuingState === "string" && typeof f.birthdate === "string"
        ? { ...MOCK_FIELDS_TX, ...f }
        : MOCK_FIELDS_TX;
    let event: string;
    try {
      event = m.provider.decide(inquiryId, outcome, fields);
    } catch {
      return json({ error: "Unknown inquiry." }, 404);
    }
    const result = await m.service.handleWebhook(new Headers(m.provider.sign()), event);
    return json({ result });
  });
}
