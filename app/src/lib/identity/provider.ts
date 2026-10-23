/**
 * The identity check behind joining: a provider verifies a government ID and residency in a hosted flow and
 * reports the outcome by webhook. Good Faith only ever stores a keyed hash of the ID fields (see person-hash.ts).
 */
export type InquiryOutcome = "approved" | "declined" | "needs_review" | "pending";

/** What a provider returns for an approved inquiry. Only what the person hash and the eligibility rules need. */
export type VerifiedFields = {
  /** Government ID number as printed. */
  idNumber: string;
  /** Issuing state or subdivision code, e.g. "TX". */
  issuingState: string;
  /** YYYY-MM-DD. */
  birthdate: string;
  /** Document class, e.g. "dl" or "pp". */
  idClass?: string;
};

export type ProviderEvent = {
  /** Provider's event id, used to ignore redeliveries. */
  eventId: string;
  inquiryId: string;
  /** The reference we gave the inquiry at creation (the wallet). */
  referenceId?: string;
  outcome: InquiryOutcome;
};

export type HeaderBag = { get(name: string): string | null };

export interface IdentityProvider {
  readonly name: string;
  /** Creates a hosted inquiry tagged with our reference and returns where to send the person. */
  createInquiry(referenceId: string): Promise<{ inquiryId: string; url: string }>;
  /** True when a webhook delivery carries a valid signature for its raw body. */
  verifyWebhook(headers: HeaderBag, rawBody: string, nowSec?: number): boolean;
  /** The event in a webhook body, or null when it is not one we act on. */
  parseEvent(rawBody: string): ProviderEvent | null;
  /** The verified fields of an approved inquiry. */
  fetchVerified(inquiryId: string): Promise<VerifiedFields | null>;
}
