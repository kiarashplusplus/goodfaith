/**
 * Persona (withpersona.com): inquiries are created server-side with a template, completed in Persona's hosted
 * flow, and reported by signed webhooks. Attribute keys come from the template, so they are configurable; the
 * defaults match Persona's standard government-ID template. Confirm them against a sandbox inquiry.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { HeaderBag, IdentityProvider, InquiryOutcome, ProviderEvent, VerifiedFields } from "./provider";

export type PersonaConfig = {
  apiKey: string;
  templateId: string;
  webhookSecret: string;
  baseUrl?: string;
  /** Persona API version header. */
  version?: string;
  fetch?: typeof fetch;
  /** Attribute keys inside `attributes.fields` of an inquiry. */
  fieldKeys?: Partial<typeof DEFAULT_FIELD_KEYS>;
  /** Accepted clock skew for webhook timestamps, seconds. */
  toleranceSec?: number;
};

export const DEFAULT_FIELD_KEYS = {
  idNumber: "identification-number",
  issuingState: "address-subdivision",
  birthdate: "birthdate",
  idClass: "identification-class",
};

const OUTCOMES: Record<string, InquiryOutcome> = {
  "inquiry.approved": "approved",
  "inquiry.declined": "declined",
  "inquiry.marked-for-review": "needs_review",
  "inquiry.failed": "declined",
  "inquiry.expired": "declined",
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Parses `t=<unix>,v1=<hex>[,v1=<hex>]`. */
export function parsePersonaSignature(header: string | null): { t: number; v1: string[] } | null {
  if (!header) return null;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && v && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && v && /^[0-9a-f]+$/i.test(v)) v1.push(v.toLowerCase());
  }
  return t !== null && v1.length ? { t, v1 } : null;
}

export function personaDigest(secret: string, t: number | string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
}

export class PersonaProvider implements IdentityProvider {
  readonly name = "persona";
  private readonly cfg: Required<Omit<PersonaConfig, "fieldKeys">> & { fieldKeys: typeof DEFAULT_FIELD_KEYS };

  constructor(cfg: PersonaConfig) {
    if (!cfg.apiKey || !cfg.templateId || !cfg.webhookSecret) throw new Error("Persona needs apiKey, templateId and webhookSecret.");
    this.cfg = {
      baseUrl: "https://api.withpersona.com",
      version: "2023-01-05",
      fetch: globalThis.fetch,
      toleranceSec: 300,
      ...cfg,
      fieldKeys: { ...DEFAULT_FIELD_KEYS, ...cfg.fieldKeys },
    };
  }

  private async call(path: string, init: RequestInit = {}): Promise<Json> {
    const res = await this.cfg.fetch(`${this.cfg.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.cfg.apiKey}`,
        "persona-version": this.cfg.version,
        "content-type": "application/json",
        accept: "application/json",
        ...(init.headers ?? {}),
      },
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // handled below
    }
    if (!res.ok || !obj(json)) throw new Error(`Persona ${path} returned HTTP ${res.status}.`);
    return json as Json;
  }

  async createInquiry(referenceId: string): Promise<{ inquiryId: string; url: string }> {
    const body = {
      data: { attributes: { "inquiry-template-id": this.cfg.templateId, "reference-id": referenceId } },
      meta: { "auto-create-one-time-link": true },
    };
    const json = await this.call("/api/v1/inquiries", { method: "POST", body: JSON.stringify(body) });
    const inquiryId = str(obj(json.data)?.id);
    const meta = obj(json.meta);
    const url = str(meta?.["one-time-link"]) ?? str(meta?.["one-time-link-short"]);
    if (!inquiryId || !url) throw new Error("Persona did not return an inquiry id and a one-time link.");
    return { inquiryId, url };
  }

  verifyWebhook(headers: HeaderBag, rawBody: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
    const sig = parsePersonaSignature(headers.get("persona-signature"));
    if (!sig) return false;
    if (Math.abs(nowSec - sig.t) > this.cfg.toleranceSec) return false;
    const expected = Buffer.from(personaDigest(this.cfg.webhookSecret, sig.t, rawBody), "hex");
    return sig.v1.some((v) => {
      const given = Buffer.from(v, "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
  }

  parseEvent(rawBody: string): ProviderEvent | null {
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const data = obj(obj(json)?.data);
    const attrs = obj(data?.attributes);
    const eventId = str(data?.id);
    const name = str(attrs?.name);
    const inquiry = obj(obj(obj(attrs?.payload)?.data));
    const inquiryId = str(inquiry?.id);
    if (!eventId || !name || !inquiryId) return null;
    const outcome = OUTCOMES[name];
    if (!outcome) return null;
    const referenceId = str(obj(inquiry?.attributes)?.["reference-id"]) ?? undefined;
    return { eventId, inquiryId, referenceId, outcome };
  }

  async fetchVerified(inquiryId: string): Promise<VerifiedFields | null> {
    const json = await this.call(`/api/v1/inquiries/${encodeURIComponent(inquiryId)}`);
    const attrs = obj(obj(json.data)?.attributes);
    if (str(attrs?.status) !== "approved") return null;
    const fields = obj(attrs?.fields) ?? {};
    const value = (key: string): string | null => {
      const f = obj(fields[key]);
      return str(f?.value);
    };
    const k = this.cfg.fieldKeys;
    const idNumber = value(k.idNumber);
    const issuingState = value(k.issuingState);
    const birthdate = value(k.birthdate);
    if (!idNumber || !issuingState || !birthdate) return null;
    return { idNumber, issuingState, birthdate, idClass: value(k.idClass) ?? undefined };
  }
}
