/**
 * A provider for tests and the fork e2e: no network, deterministic ids, outcomes decided by the test
 * (or by the reference: a reference ending in "-no" is declined). Webhooks are "signed" with a shared secret.
 */
import type { HeaderBag, IdentityProvider, InquiryOutcome, ProviderEvent, VerifiedFields } from "./provider";

export const MOCK_FIELDS_TX: VerifiedFields = { idNumber: "12345678", issuingState: "TX", birthdate: "1990-05-04", idClass: "dl" };

export class MockProvider implements IdentityProvider {
  readonly name = "mock";
  private n = 0;
  private readonly inquiries = new Map<string, { referenceId: string; fields: VerifiedFields | null; outcome: InquiryOutcome }>();
  constructor(
    private readonly secret = "mock-secret",
    private readonly hostedBase = "/api/identity/mock",
  ) {}

  async createInquiry(referenceId: string) {
    const inquiryId = `mock-${++this.n}`;
    this.inquiries.set(inquiryId, { referenceId, fields: null, outcome: "pending" });
    return { inquiryId, url: `${this.hostedBase}?inquiry=${inquiryId}` };
  }

  /** Test hook: settle an inquiry. Approved inquiries get `fields` (Texas adult by default). */
  decide(inquiryId: string, outcome: InquiryOutcome, fields: VerifiedFields | null = MOCK_FIELDS_TX): string {
    const q = this.inquiries.get(inquiryId);
    if (!q) throw new Error(`unknown inquiry ${inquiryId}`);
    q.outcome = outcome;
    q.fields = outcome === "approved" ? fields : null;
    return JSON.stringify({ eventId: `evt-${inquiryId}-${outcome}-${Date.now()}`, inquiryId, referenceId: q.referenceId, outcome });
  }

  referenceOf(inquiryId: string): string | undefined {
    return this.inquiries.get(inquiryId)?.referenceId;
  }

  /** The header a webhook needs. */
  sign(): Record<string, string> {
    return { "x-mock-signature": this.secret };
  }

  verifyWebhook(headers: HeaderBag): boolean {
    return headers.get("x-mock-signature") === this.secret;
  }

  parseEvent(rawBody: string): ProviderEvent | null {
    try {
      const j = JSON.parse(rawBody) as Partial<ProviderEvent>;
      if (typeof j.eventId !== "string" || typeof j.inquiryId !== "string" || typeof j.outcome !== "string") return null;
      return { eventId: j.eventId, inquiryId: j.inquiryId, referenceId: j.referenceId, outcome: j.outcome };
    } catch {
      return null;
    }
  }

  async fetchVerified(inquiryId: string): Promise<VerifiedFields | null> {
    const q = this.inquiries.get(inquiryId);
    return q?.outcome === "approved" ? q.fields : null;
  }
}
